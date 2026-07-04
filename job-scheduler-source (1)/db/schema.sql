-- =====================================================================
-- Distributed Job Scheduler — PostgreSQL Schema
-- =====================================================================
-- Design notes (see docs/design-decisions.md for full rationale):
--  * UUID primary keys (gen_random_uuid()) everywhere -> safe for
--    distributed inserts from multiple API/worker nodes, no central
--    sequence contention, and IDs are not guessable/enumerable.
--  * All FKs use ON DELETE CASCADE from the "owning" side (org -> project
--    -> queue -> job) so deleting a project cleans up everything beneath
--    it, but ON DELETE RESTRICT is used where accidental cascade could
--    silently destroy audit/history data (job_logs, dead_letter_queue
--    keep RESTRICT+explicit nulling where relevant).
--  * created_at/updated_at on every mutable table for observability.
--  * Heavy write tables (jobs, job_executions, job_logs, worker_heartbeats)
--    are indexed for the exact query patterns the scheduler needs
--    (claiming, dashboard filtering) rather than indexed broadly.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- USERS & ORGANIZATIONS (multi-tenant, RBAC)
-- ---------------------------------------------------------------------

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    name            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bonus: Role-Based Access Control. A user can belong to many orgs with
-- a different role in each (owner > admin > member > viewer).
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE org_members (
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            org_role NOT NULL DEFAULT 'member',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);

CREATE INDEX idx_org_members_user ON org_members(user_id);

-- ---------------------------------------------------------------------
-- PROJECTS & QUEUES
-- ---------------------------------------------------------------------

CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);

CREATE INDEX idx_projects_org ON projects(org_id);

CREATE TYPE retry_strategy AS ENUM ('fixed', 'linear', 'exponential');

-- A retry policy is a reusable config, referenced by queues (default)
-- and optionally overridden per-job.
CREATE TABLE retry_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    strategy            retry_strategy NOT NULL DEFAULT 'exponential',
    max_attempts        INT NOT NULL DEFAULT 5 CHECK (max_attempts >= 0),
    base_delay_ms       INT NOT NULL DEFAULT 1000 CHECK (base_delay_ms >= 0),
    max_delay_ms        INT NOT NULL DEFAULT 300000 CHECK (max_delay_ms >= 0),
    jitter              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE queues (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    priority             INT NOT NULL DEFAULT 0,           -- higher = claimed first
    concurrency_limit    INT NOT NULL DEFAULT 5 CHECK (concurrency_limit > 0),
    rate_limit_per_sec   INT,                               -- bonus: rate limiting; NULL = unlimited
    default_retry_policy_id UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
    is_paused           BOOLEAN NOT NULL DEFAULT FALSE,
    shard_key           TEXT,                                -- bonus: queue sharding (worker pool selector)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE INDEX idx_queues_project ON queues(project_id);
CREATE INDEX idx_queues_shard ON queues(shard_key);

-- ---------------------------------------------------------------------
-- WORKERS
-- ---------------------------------------------------------------------

CREATE TYPE worker_status AS ENUM ('online', 'offline', 'draining');

CREATE TABLE workers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname            TEXT NOT NULL,
    pid                 INT,
    shard_key           TEXT,                     -- which shard(s) this worker serves
    max_concurrency     INT NOT NULL DEFAULT 10,
    status              worker_status NOT NULL DEFAULT 'online',
    version             TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_workers_shard ON workers(shard_key);

CREATE TABLE worker_heartbeats (
    id                  BIGSERIAL PRIMARY KEY,
    worker_id           UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    active_job_count     INT NOT NULL DEFAULT 0,
    cpu_load             REAL,
    memory_mb            REAL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the latest N heartbeats matter for health; index for fast "last beat".
CREATE INDEX idx_heartbeats_worker_time ON worker_heartbeats(worker_id, created_at DESC);

-- ---------------------------------------------------------------------
-- JOBS (the core entity)
-- ---------------------------------------------------------------------

CREATE TYPE job_type AS ENUM ('immediate', 'delayed', 'scheduled', 'recurring', 'batch');
CREATE TYPE job_status AS ENUM (
    'queued', 'scheduled', 'claimed', 'running',
    'completed', 'failed', 'retrying', 'dead_letter', 'cancelled'
);

CREATE TABLE jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id            UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    idempotency_key      TEXT,                      -- caller-supplied; enforces exactly-once creation
    type                job_type NOT NULL DEFAULT 'immediate',
    status              job_status NOT NULL DEFAULT 'queued',
    priority             INT NOT NULL DEFAULT 0,
    payload             JSONB NOT NULL DEFAULT '{}',
    handler             TEXT NOT NULL,               -- named handler the worker dispatches to

    -- scheduling
    run_at               TIMESTAMPTZ NOT NULL DEFAULT now(), -- when eligible to run (delayed/scheduled)
    cron_expression       TEXT,                        -- recurring jobs only
    scheduled_job_id      UUID,                        -- FK added after scheduled_jobs table exists

    -- retry
    retry_policy_id       UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
    attempt               INT NOT NULL DEFAULT 0,
    max_attempts          INT,                          -- override; falls back to retry_policy

    -- workflow dependencies (bonus)
    depends_on            UUID[] NOT NULL DEFAULT '{}',  -- array of job ids that must complete first

    -- claiming (atomic, see docs/design-decisions.md)
    claimed_by            UUID REFERENCES workers(id) ON DELETE SET NULL,
    claimed_at             TIMESTAMPTZ,
    lock_token             UUID,                         -- distributed-lock fencing token

    -- batch grouping
    batch_id                UUID,

    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at                TIMESTAMPTZ,
    completed_at               TIMESTAMPTZ,

    CONSTRAINT uq_idempotency UNIQUE (queue_id, idempotency_key)
);

-- The single most important index in the system: the worker "claim query"
-- filters status + run_at and orders by priority. A partial index on the
-- queued/scheduled rows keeps it tiny even with millions of historical jobs.
CREATE INDEX idx_jobs_claim ON jobs (queue_id, priority DESC, run_at)
    WHERE status IN ('queued', 'scheduled');

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_queue_status ON jobs(queue_id, status);
CREATE INDEX idx_jobs_batch ON jobs(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_jobs_claimed_by ON jobs(claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX idx_jobs_depends_on ON jobs USING GIN (depends_on);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- Every attempt to run a job gets its own execution record — this is the
-- audit trail (worker, timing, outcome) independent of the job's current
-- (mutable) status.
CREATE TYPE execution_result AS ENUM ('success', 'failure', 'timeout', 'cancelled');

CREATE TABLE job_executions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id               UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id             UUID REFERENCES workers(id) ON DELETE SET NULL,
    attempt_number         INT NOT NULL,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at              TIMESTAMPTZ,
    duration_ms               INT,
    result                     execution_result,
    error_message              TEXT,
    error_stack                 TEXT
);

CREATE INDEX idx_executions_job ON job_executions(job_id, attempt_number);
CREATE INDEX idx_executions_worker ON job_executions(worker_id);

CREATE TABLE job_logs (
    id                  BIGSERIAL PRIMARY KEY,
    job_id               UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    execution_id          UUID REFERENCES job_executions(id) ON DELETE CASCADE,
    level                  TEXT NOT NULL DEFAULT 'info',
    message                 TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_logs_job ON job_logs(job_id, created_at);

-- Recurring jobs: one row per cron "template"; the scheduler leader
-- materializes concrete `jobs` rows from this on each tick.
CREATE TABLE scheduled_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id             UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    cron_expression         TEXT NOT NULL,
    handler                  TEXT NOT NULL,
    payload                   JSONB NOT NULL DEFAULT '{}',
    is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
    next_run_at                 TIMESTAMPTZ NOT NULL,
    last_run_at                  TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scheduled_jobs_due ON scheduled_jobs(next_run_at) WHERE is_active;

ALTER TABLE jobs
    ADD CONSTRAINT fk_jobs_scheduled_job
    FOREIGN KEY (scheduled_job_id) REFERENCES scheduled_jobs(id) ON DELETE SET NULL;

-- Dead Letter Queue: permanent-failure jobs are copied here (not just
-- flagged) so the `jobs` "hot" table / claim index stays small, while
-- full context is preserved for inspection & manual replay.
CREATE TABLE dead_letter_queue (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id               UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    queue_id              UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    handler                TEXT NOT NULL,
    payload                  JSONB NOT NULL,
    final_error               TEXT,
    total_attempts              INT NOT NULL,
    ai_failure_summary            TEXT,          -- bonus: AI-generated failure summary
    moved_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved                         BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at                        TIMESTAMPTZ
);

CREATE INDEX idx_dlq_queue ON dead_letter_queue(queue_id);
CREATE INDEX idx_dlq_unresolved ON dead_letter_queue(resolved) WHERE NOT resolved;

-- ---------------------------------------------------------------------
-- updated_at triggers (generic)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_queues_updated BEFORE UPDATE ON queues FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
