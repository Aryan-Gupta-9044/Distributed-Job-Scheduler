# API Documentation

Base URL: `http://localhost:4000/api`
All endpoints except `/auth/*` require `Authorization: Bearer <jwt>`.
All responses are JSON. Errors follow:

```json
{ "error": { "code": "SOME_CODE", "message": "human readable", "details": null } }
```

---

## Auth

### `POST /auth/register`
Creates a user **and** their first organization (caller becomes `owner`).

```json
// request
{ "email": "a@b.com", "password": "min8chars", "name": "Ada", "orgName": "Acme" }
// response 201
{ "token": "<jwt>", "user": {...}, "organization": {...} }
```

### `POST /auth/login`
```json
{ "email": "a@b.com", "password": "..." }
// -> { "token": "<jwt>", "user": {...} }
```

---

## Organizations & Projects

| Method | Path | Role required | Description |
|---|---|---|---|
| GET | `/orgs` | member of org | List orgs the caller belongs to, with their role |
| POST | `/orgs/:orgId/projects` | admin | Create a project |
| GET | `/orgs/:orgId/projects` | viewer | List projects |
| POST | `/orgs/:orgId/members` | admin | Add/update a member's role (`admin`\|`member`\|`viewer`) |

---

## Queues

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/projects/:projectId/queues` | admin | Create a queue (priority, concurrency, rate limit, retry policy, shard key) |
| GET | `/projects/:projectId/queues` | viewer | List queues in a project |
| PATCH | `/queues/:queueId` | admin | Update `priority` / `concurrencyLimit` / `rateLimitPerSec` / `isPaused` |
| GET | `/queues/:queueId/stats` | viewer | Status counts + last-hour completion throughput |
| POST | `/queues/:queueId/pause` | admin | Stop claiming new jobs from this queue |
| POST | `/queues/:queueId/resume` | admin | Resume claiming |

**Create queue example**
```json
POST /projects/<id>/queues
{
  "name": "emails",
  "priority": 10,
  "concurrencyLimit": 5,
  "rateLimitPerSec": 20,
  "shardKey": "default",
  "retryPolicy": { "strategy": "exponential", "maxAttempts": 5, "baseDelayMs": 1000, "maxDelayMs": 300000, "jitter": true }
}
```

---

## Jobs

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/queues/:queueId/jobs` | member | Create a job (see types below) |
| POST | `/queues/:queueId/jobs/batch` | member | Create up to 1000 jobs sharing a `batch_id` |
| GET | `/queues/:queueId/jobs?status=&page=&pageSize=` | viewer | Paginated, filterable job list |
| GET | `/jobs/:jobId` | viewer | Job detail + its executions + logs |
| POST | `/jobs/:jobId/cancel` | member | Cancel a job still in `queued`/`scheduled`/`retrying` |

**Job types** (discriminated by `type`):

```jsonc
// immediate — runs as soon as a worker has capacity
{ "type": "immediate", "handler": "send-email", "payload": { "to": "x@y.com" } }

// delayed — eligible after N seconds
{ "type": "delayed", "handler": "send-email", "payload": {...}, "delaySeconds": 300 }

// scheduled — eligible at an exact timestamp
{ "type": "scheduled", "handler": "generate-report", "payload": {...}, "runAt": "2026-08-01T00:00:00Z" }

// recurring — a cron *template*; the scheduler leader materializes concrete jobs
{ "type": "recurring", "name": "nightly-report", "cronExpression": "0 2 * * *", "handler": "generate-report", "payload": {} }
```

Optional fields on any (non-recurring) job:
- `priority` (int, default 0, higher runs first within a queue)
- `idempotencyKey` (string) — if a job with the same key already exists
  in the queue, the existing job is returned instead of creating a
  duplicate (`{"deduplicated": true}`).
- `maxAttempts` (int) — overrides the queue's default retry policy.
- `dependsOn` (string[] of job ids) — this job is only claimable once
  every listed job has `status = completed` (workflow dependencies).

---

## Dead Letter Queue

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/queues/:queueId/dlq` | viewer | Paginated list of permanently-failed jobs, including `ai_failure_summary` |
| POST | `/dlq/:dlqId/replay` | admin | Re-enqueues the original handler/payload as a brand-new job |

---

## Workers (called by worker processes, not end users)

| Method | Path | Description |
|---|---|---|
| POST | `/workers/register` | Registers a new worker process, returns its `id` |
| POST | `/workers/:workerId/heartbeat` | Reports liveness + active job count |
| POST | `/workers/:workerId/claim` | Atomically claims up to `batchSize` jobs from a queue |
| POST | `/workers/:workerId/report` | Reports success/failure for a claimed job (requires the `lockToken` issued at claim time) |
| GET | `/workers` | List all workers with computed `is_healthy` (dashboard use) |

**Claim → execute → report cycle**
```
POST /workers/:id/claim   { "queueId": "...", "batchSize": 5 }
  -> [{ id, handler, payload, lockToken, attempt, ... }, ...]

# worker looks up `handler` in its local registry, runs it, then:
POST /workers/:id/report  { "jobId": "...", "lockToken": "...", "success": true, "durationMs": 812 }
```
If `lockToken` no longer matches (job was reclaimed from a stale worker),
the server responds `409 STALE_CLAIM` and the result is discarded — this
is the fencing-token safety check described in `design-decisions.md`.

---

## Realtime (Socket.io)

Connect to the API's base URL. Client → server events:
- `subscribe:queue` (queueId) — join a room to receive `job:update` events for that queue
- `subscribe:worker` (workerId) — join a room for `worker:update` events
- `subscribe:dashboard` (orgId) — join a room for `queue:stats` broadcasts

Server → client events: `job:update { jobId, queueId, status }`,
`worker:update { workerId, status, activeJobCount }`, `queue:stats {...}`.
