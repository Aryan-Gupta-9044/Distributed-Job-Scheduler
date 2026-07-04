import parser from "cron-parser";
import { pool } from "../db/pool.js";
import { config } from "../config/env.js";
import { DistributedLock } from "../jobs-engine/distributedLock.js";
import { reclaimOrphanedJobs } from "../jobs-engine/reportResult.js";

/**
 * This process can be run on N nodes for HA, but only the one holding
 * the `scheduler-leader` distributed lock actually does work on a given
 * tick — everyone else just keeps retrying to acquire it. If the leader
 * crashes, the lock's TTL expires and another instance takes over
 * within seconds. This is the "event-driven execution" backbone: cron
 * templates -> concrete job rows -> claimed by workers -> executed.
 */
async function tick() {
  const lock = new DistributedLock("scheduler-leader", 8000);
  if (!(await lock.tryAcquire())) return; // another instance is leader this tick

  try {
    await materializeDueCronJobs();
    await sweepStaleWorkers();
  } finally {
    await lock.release();
  }
}

async function materializeDueCronJobs() {
  const { rows: due } = await pool.query(
    `SELECT * FROM scheduled_jobs WHERE is_active AND next_run_at <= now()`
  );
  for (const sched of due) {
    await pool.query(
      `INSERT INTO jobs (queue_id, type, payload, handler, run_at, scheduled_job_id)
       VALUES ($1,'recurring',$2,$3, now(), $4)`,
      [sched.queue_id, sched.payload, sched.handler, sched.id]
    );
    const next = parser.parseExpression(sched.cron_expression).next().toDate();
    await pool.query(`UPDATE scheduled_jobs SET last_run_at = now(), next_run_at = $1 WHERE id = $2`, [next, sched.id]);
  }
}

async function sweepStaleWorkers() {
  const { rows: stale } = await pool.query(
    `SELECT id FROM workers WHERE status != 'offline' AND last_seen_at < now() - ($1 || ' milliseconds')::interval`,
    [config.workerStaleAfterMs]
  );
  const staleIds = stale.map((r) => r.id);
  if (staleIds.length === 0) return;
  await pool.query(`UPDATE workers SET status = 'offline' WHERE id = ANY($1)`, [staleIds]);
  const reclaimed = await reclaimOrphanedJobs(staleIds);
  if (reclaimed > 0) console.log(`[scheduler] reclaimed ${reclaimed} jobs from ${staleIds.length} stale workers`);
}

setInterval(() => tick().catch(console.error), 3000);
tick();
