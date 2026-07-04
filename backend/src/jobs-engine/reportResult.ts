import { pool } from "../db/pool.js";
import { computeNextDelayMs, shouldMoveToDeadLetter, RetryPolicy } from "./retryPolicy.js";
import { emitJobUpdate } from "../realtime/socket.js";
import { maybeGenerateFailureSummary } from "./aiFailureSummary.js";

interface ReportResultInput {
  jobId: string;
  workerId: string;
  lockToken: string; // fencing token from claim — must match current row
  success: boolean;
  errorMessage?: string;
  errorStack?: string;
  durationMs: number;
}

const DEFAULT_POLICY: RetryPolicy = {
  strategy: "exponential",
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 300000,
  jitter: true,
};

/**
 * Applies a worker's execution result to a job.
 *
 * Fencing-token check: if the job's current `lock_token` in the DB no
 * longer matches the token the worker was issued at claim time, this
 * worker has been superseded (its heartbeat went stale, another worker
 * reclaimed the job) and its result is *rejected*. This prevents a
 * "zombie" worker — e.g. one stuck in a long GC pause — from
 * overwriting a newer execution's outcome. This is the core reliability
 * guarantee that makes horizontal worker scaling safe.
 */
export async function reportResult(input: ReportResultInput): Promise<{ accepted: boolean; newStatus?: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id, status, lock_token, attempt, max_attempts, retry_policy_id, queue_id, handler, payload
         FROM jobs WHERE id = $1 FOR UPDATE`,
      [input.jobId]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { accepted: false };
    }
    const job = rows[0];

    if (job.lock_token !== input.lockToken) {
      // Stale worker — someone else owns this job now. Reject silently.
      await client.query("ROLLBACK");
      return { accepted: false };
    }

    // Record the execution attempt regardless of outcome (audit trail).
    const { rows: execRows } = await client.query(
      `INSERT INTO job_executions (job_id, worker_id, attempt_number, started_at, finished_at, duration_ms, result, error_message, error_stack)
       VALUES ($1,$2,$3, now() - ($4 || ' milliseconds')::interval, now(), $4, $5, $6, $7)
       RETURNING id`,
      [
        input.jobId,
        input.workerId,
        job.attempt,
        input.durationMs,
        input.success ? "success" : "failure",
        input.errorMessage ?? null,
        input.errorStack ?? null,
      ]
    );
    const executionId = execRows[0].id;

    if (input.success) {
      await client.query(
        `UPDATE jobs SET status = 'completed', completed_at = now(), lock_token = NULL WHERE id = $1`,
        [input.jobId]
      );
      await client.query(
        `INSERT INTO job_logs (job_id, execution_id, level, message) VALUES ($1,$2,'info','Job completed successfully')`,
        [input.jobId, executionId]
      );
      await client.query("COMMIT");
      emitJobUpdate({ jobId: input.jobId, queueId: job.queue_id, status: "completed" });
      return { accepted: true, newStatus: "completed" };
    }

    // --- failure path: retry or dead-letter ---
    let policy = DEFAULT_POLICY;
    if (job.retry_policy_id) {
      const { rows: pRows } = await client.query(
        `SELECT strategy, max_attempts, base_delay_ms, max_delay_ms, jitter FROM retry_policies WHERE id = $1`,
        [job.retry_policy_id]
      );
      if (pRows.length) {
        policy = {
          strategy: pRows[0].strategy,
          maxAttempts: job.max_attempts ?? pRows[0].max_attempts,
          baseDelayMs: pRows[0].base_delay_ms,
          maxDelayMs: pRows[0].max_delay_ms,
          jitter: pRows[0].jitter,
        };
      }
    } else if (job.max_attempts) {
      policy = { ...DEFAULT_POLICY, maxAttempts: job.max_attempts };
    }

    const dead = shouldMoveToDeadLetter(policy, job.attempt);

    if (dead) {
      await client.query(
        `UPDATE jobs SET status = 'dead_letter', lock_token = NULL WHERE id = $1`,
        [input.jobId]
      );
      await client.query(
        `INSERT INTO dead_letter_queue (job_id, queue_id, handler, payload, final_error, total_attempts)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.jobId, job.queue_id, job.handler, job.payload, input.errorMessage ?? "unknown error", job.attempt]
      );
      await client.query("COMMIT");
      emitJobUpdate({ jobId: input.jobId, queueId: job.queue_id, status: "dead_letter" });
      // Bonus: fire-and-forget AI failure summary (does not block the transaction)
      void maybeGenerateFailureSummary(input.jobId, job.handler, input.errorMessage ?? "unknown error");
      return { accepted: true, newStatus: "dead_letter" };
    } else {
      const delayMs = computeNextDelayMs(policy, job.attempt);
      await client.query(
        `UPDATE jobs
            SET status = 'queued', lock_token = NULL, claimed_by = NULL, claimed_at = NULL,
                run_at = now() + ($1 || ' milliseconds')::interval
          WHERE id = $2`,
        [delayMs, input.jobId]
      );
      await client.query(
        `INSERT INTO job_logs (job_id, execution_id, level, message)
         VALUES ($1,$2,'warn',$3)`,
        [input.jobId, executionId, `Attempt ${job.attempt} failed, retrying in ${delayMs}ms: ${input.errorMessage ?? ""}`]
      );
      await client.query("COMMIT");
      emitJobUpdate({ jobId: input.jobId, queueId: job.queue_id, status: "queued" });
      return { accepted: true, newStatus: "queued" };
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reclaims jobs stuck in 'claimed'/'running' whose owning worker has
 * missed its heartbeat window. Run periodically (see runReclaimSweep.ts).
 * This is what makes a hard worker crash self-heal instead of leaving
 * jobs stuck forever.
 */
export async function reclaimOrphanedJobs(staleWorkerIds: string[]): Promise<number> {
  if (staleWorkerIds.length === 0) return 0;
  const { rows } = await pool.query(
    `UPDATE jobs
        SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lock_token = NULL
      WHERE claimed_by = ANY($1) AND status IN ('claimed','running')
      RETURNING id`,
    [staleWorkerIds]
  );
  return rows.length;
}
