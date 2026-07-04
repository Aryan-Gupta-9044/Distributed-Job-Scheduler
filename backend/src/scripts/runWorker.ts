import os from "os";
import { pool } from "../db/pool.js";
import { claimJobs } from "../jobs-engine/claim.js";
import { reportResult } from "../jobs-engine/reportResult.js";
import { config } from "../config/env.js";
import { handlers } from "../jobs-engine/handlerRegistry.js";

/**
 * A worker is a plain Node process. In production you'd run N of these
 * (containers/pods) — nothing here is in-memory-shared, so they scale
 * horizontally for free; all coordination happens through Postgres
 * (SELECT FOR UPDATE SKIP LOCKED) and Redis (rate limits / locks).
 */
async function registerSelf(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO workers (hostname, pid, max_concurrency, version) VALUES ($1,$2,$3,$4) RETURNING id`,
    [os.hostname(), process.pid, Number(process.env.WORKER_CONCURRENCY ?? 5), "1.0.0"]
  );
  return rows[0].id;
}

async function heartbeat(workerId: string, activeCount: number) {
  await pool.query(`UPDATE workers SET last_seen_at = now() WHERE id = $1`, [workerId]);
  await pool.query(`INSERT INTO worker_heartbeats (worker_id, active_job_count) VALUES ($1,$2)`, [workerId, activeCount]);
}

async function runOnce(workerId: string, queueId: string) {
  const jobs = await claimJobs(queueId, workerId, 5);
  await Promise.all(
    jobs.map(async (job) => {
      const startedAt = Date.now();
      const handler = handlers[job.handler];
      try {
        if (!handler) throw new Error(`No handler registered for "${job.handler}"`);
        await handler(job.payload);
        await reportResult({
          jobId: job.id,
          workerId,
          lockToken: job.lock_token,
          success: true,
          durationMs: Date.now() - startedAt,
        });
      } catch (err: any) {
        await reportResult({
          jobId: job.id,
          workerId,
          lockToken: job.lock_token,
          success: false,
          errorMessage: err?.message ?? String(err),
          errorStack: err?.stack,
          durationMs: Date.now() - startedAt,
        });
      }
    })
  );
  return jobs.length;
}

async function main() {
  const workerId = await registerSelf();
  const queueId = process.env.WORKER_QUEUE_ID;
  if (!queueId) throw new Error("Set WORKER_QUEUE_ID to the queue this worker should poll");

  console.log(`[worker ${workerId}] polling queue ${queueId}`);

  let activeCount = 0;
  setInterval(() => heartbeat(workerId, activeCount).catch(console.error), config.workerHeartbeatIntervalMs);

  // Simple polling loop. In a fuller build this would use LISTEN/NOTIFY
  // to wake up immediately on new work instead of a fixed interval —
  // documented as a follow-up in design-decisions.md.
  while (true) {
    try {
      const n = await runOnce(workerId, queueId);
      activeCount = n;
      await new Promise((r) => setTimeout(r, n > 0 ? 200 : 1500));
    } catch (err) {
      console.error("[worker] loop error", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
