import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { redis } from "../realtime/redisClient.js";

export interface ClaimedJob {
  id: string;
  queue_id: string;
  handler: string;
  payload: unknown;
  attempt: number;
  max_attempts: number | null;
  retry_policy_id: string | null;
  lock_token: string;
}

/**
 * Atomically claims up to `batchSize` runnable jobs for `queueId` on
 * behalf of `workerId`.
 *
 * Concurrency guarantees:
 *  1. `SELECT ... FOR UPDATE SKIP LOCKED` inside a single transaction
 *     means two workers racing the same row never both win it — one
 *     gets the lock, the other silently skips to the next candidate
 *     row instead of blocking or double-claiming. This is what makes
 *     claiming atomic across N horizontally-scaled worker processes
 *     without a separate coordinator.
 *  2. The queue's `concurrency_limit` is enforced by counting jobs
 *     already `running`/`claimed` for that queue *inside the same
 *     transaction*, so the limit can't be exceeded by two concurrent
 *     claim calls each thinking they have room.
 *  3. Workflow dependencies: a job is only eligible if every id in its
 *     `depends_on` array is `completed`.
 *  4. A per-claim `lock_token` (UUID) is stamped on the row — a
 *     fencing token. If a worker is presumed dead and the job is
 *     reclaimed, the old token is invalidated, so a "zombie" worker
 *     that wakes up and tries to report completion with a stale token
 *     is rejected (see reportResult()). This is the distributed-locking
 *     bonus feature applied to job execution specifically.
 */
export async function claimJobs(
  queueId: string,
  workerId: string,
  batchSize: number
): Promise<ClaimedJob[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: queueRows } = await client.query(
      `SELECT concurrency_limit, is_paused, rate_limit_per_sec FROM queues WHERE id = $1 FOR UPDATE`,
      [queueId]
    );
    if (queueRows.length === 0 || queueRows[0].is_paused) {
      await client.query("ROLLBACK");
      return [];
    }
    const { concurrency_limit, rate_limit_per_sec } = queueRows[0];

    const { rows: activeRows } = await client.query(
      `SELECT count(*)::int AS active FROM jobs WHERE queue_id = $1 AND status IN ('claimed','running')`,
      [queueId]
    );
    const capacity = concurrency_limit - activeRows[0].active;
    if (capacity <= 0) {
      await client.query("ROLLBACK");
      return [];
    }

    // Bonus: rate limiting — token bucket in Redis, checked before we
    // commit to claiming rows so a saturated downstream API doesn't get
    // hammered even if DB capacity is free.
    let effectiveBatch = Math.min(batchSize, capacity);
    if (rate_limit_per_sec) {
      const allowed = await takeRateLimitTokens(queueId, rate_limit_per_sec, effectiveBatch);
      effectiveBatch = allowed;
      if (effectiveBatch <= 0) {
        await client.query("ROLLBACK");
        return [];
      }
    }

    const { rows: candidates } = await client.query(
      `SELECT j.id, j.queue_id, j.handler, j.payload, j.attempt, j.max_attempts,
              j.retry_policy_id, j.depends_on
         FROM jobs j
        WHERE j.queue_id = $1
          AND j.status IN ('queued','scheduled')
          AND j.run_at <= now()
          AND (
                cardinality(j.depends_on) = 0
                OR NOT EXISTS (
                  SELECT 1 FROM unnest(j.depends_on) dep_id
                   WHERE dep_id NOT IN (
                     SELECT id FROM jobs WHERE id = ANY(j.depends_on) AND status = 'completed'
                   )
                )
              )
        ORDER BY j.priority DESC, j.run_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [queueId, effectiveBatch]
    );

    if (candidates.length === 0) {
      await client.query("ROLLBACK");
      return [];
    }

    const claimed: ClaimedJob[] = [];
    for (const row of candidates) {
      const lockToken = uuid();
      await client.query(
        `UPDATE jobs
            SET status = 'claimed', claimed_by = $1, claimed_at = now(),
                lock_token = $2, attempt = attempt + 1
          WHERE id = $3`,
        [workerId, lockToken, row.id]
      );
      claimed.push({
        id: row.id,
        queue_id: row.queue_id,
        handler: row.handler,
        payload: row.payload,
        attempt: row.attempt + 1,
        max_attempts: row.max_attempts,
        retry_policy_id: row.retry_policy_id,
        lock_token: lockToken,
      });
    }

    await client.query("COMMIT");
    return claimed;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Redis token-bucket rate limiter. Returns how many tokens (<=requested) were granted. */
async function takeRateLimitTokens(queueId: string, perSecond: number, requested: number): Promise<number> {
  const key = `ratelimit:${queueId}`;
  const script = `
    local tokens = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
    local granted = math.min(tokens, tonumber(ARGV[2]))
    if granted > 0 then
      redis.call('SET', KEYS[1], tokens - granted, 'EX', 1)
    end
    return granted
  `;
  const granted = await redis.eval(script, 1, key, String(perSecond), String(requested));
  return Number(granted);
}
