import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

export const queuesRouter = Router();
queuesRouter.use(requireAuth);

const createQueueSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().default(0),
  concurrencyLimit: z.number().int().positive().default(5),
  rateLimitPerSec: z.number().int().positive().optional(),
  shardKey: z.string().optional(),
  retryPolicy: z
    .object({
      strategy: z.enum(["fixed", "linear", "exponential"]).default("exponential"),
      maxAttempts: z.number().int().min(0).default(5),
      baseDelayMs: z.number().int().min(0).default(1000),
      maxDelayMs: z.number().int().min(0).default(300000),
      jitter: z.boolean().default(true),
    })
    .optional(),
});

queuesRouter.post(
  "/projects/:projectId/queues",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const body = createQueueSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let retryPolicyId: string | null = null;
      if (body.retryPolicy) {
        const { rows } = await client.query(
          `INSERT INTO retry_policies (name, strategy, max_attempts, base_delay_ms, max_delay_ms, jitter)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [`${body.name}-default`, body.retryPolicy.strategy, body.retryPolicy.maxAttempts, body.retryPolicy.baseDelayMs, body.retryPolicy.maxDelayMs, body.retryPolicy.jitter]
        );
        retryPolicyId = rows[0].id;
      }
      const { rows: qRows } = await client.query(
        `INSERT INTO queues (project_id, name, priority, concurrency_limit, rate_limit_per_sec, shard_key, default_retry_policy_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.params.projectId, body.name, body.priority, body.concurrencyLimit, body.rateLimitPerSec ?? null, body.shardKey ?? null, retryPolicyId]
      );
      await client.query("COMMIT");
      res.status(201).json({ data: qRows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

queuesRouter.get(
  "/projects/:projectId/queues",
  requireRole("viewer"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM queues WHERE project_id = $1 ORDER BY created_at`, [
      req.params.projectId,
    ]);
    res.json({ data: rows });
  })
);

const patchQueueSchema = z.object({
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().positive().optional(),
  rateLimitPerSec: z.number().int().positive().nullable().optional(),
  isPaused: z.boolean().optional(),
});

queuesRouter.patch(
  "/queues/:queueId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const body = patchQueueSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const map: Record<string, string> = {
      priority: "priority",
      concurrencyLimit: "concurrency_limit",
      rateLimitPerSec: "rate_limit_per_sec",
      isPaused: "is_paused",
    };
    for (const [key, col] of Object.entries(map)) {
      if ((body as any)[key] !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push((body as any)[key]);
      }
    }
    if (fields.length === 0) return res.json({ data: null });
    values.push(req.params.queueId);
    const { rows } = await pool.query(`UPDATE queues SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    res.json({ data: rows[0] });
  })
);

// Queue statistics for the dashboard: counts per status + rough throughput.
queuesRouter.get(
  "/queues/:queueId/stats",
  requireRole("viewer"),
  asyncHandler(async (req, res) => {
    const { rows: statusCounts } = await pool.query(
      `SELECT status, count(*)::int AS count FROM jobs WHERE queue_id = $1 GROUP BY status`,
      [req.params.queueId]
    );
    const { rows: throughput } = await pool.query(
      `SELECT date_trunc('minute', completed_at) AS minute, count(*)::int AS completed
         FROM jobs WHERE queue_id = $1 AND completed_at > now() - interval '1 hour' AND status = 'completed'
         GROUP BY 1 ORDER BY 1`,
      [req.params.queueId]
    );
    res.json({ data: { statusCounts, throughput } });
  })
);

queuesRouter.post(
  "/queues/:queueId/pause",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await pool.query(`UPDATE queues SET is_paused = TRUE WHERE id = $1`, [req.params.queueId]);
    res.json({ data: { paused: true } });
  })
);

queuesRouter.post(
  "/queues/:queueId/resume",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await pool.query(`UPDATE queues SET is_paused = FALSE WHERE id = $1`, [req.params.queueId]);
    res.json({ data: { paused: false } });
  })
);
