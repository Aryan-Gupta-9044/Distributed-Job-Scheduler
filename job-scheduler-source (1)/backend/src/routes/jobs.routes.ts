import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncHandler, ApiError, paginationParams } from "../utils/errors.js";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import parser from "cron-parser";

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

const baseJobFields = {
  handler: z.string().min(1),
  payload: z.record(z.any()).default({}),
  priority: z.number().int().default(0),
  idempotencyKey: z.string().optional(),
  maxAttempts: z.number().int().min(0).optional(),
  dependsOn: z.array(z.string().uuid()).default([]),
};

const createJobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("immediate"), ...baseJobFields }),
  z.object({ type: z.literal("delayed"), delaySeconds: z.number().int().positive(), ...baseJobFields }),
  z.object({ type: z.literal("scheduled"), runAt: z.string().datetime(), ...baseJobFields }),
  z.object({ type: z.literal("recurring"), cronExpression: z.string().min(1), name: z.string().min(1), ...baseJobFields }),
]);

// Single job creation — immediate / delayed / scheduled / recurring.
jobsRouter.post(
  "/queues/:queueId/jobs",
  requireRole("member"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = createJobSchema.parse(req.body);
    const queueId = req.params.queueId;

    if (body.type === "recurring") {
      let next: Date;
      try {
        next = parser.parseExpression(body.cronExpression).next().toDate();
      } catch {
        throw new ApiError(400, "INVALID_CRON", "cronExpression is not a valid cron expression");
      }
      const { rows } = await pool.query(
        `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, handler, payload, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [queueId, body.name, body.cronExpression, body.handler, body.payload, next]
      );
      return res.status(201).json({ data: rows[0], kind: "scheduled_job_template" });
    }

    let runAt = new Date();
    if (body.type === "delayed") runAt = new Date(Date.now() + body.delaySeconds * 1000);
    if (body.type === "scheduled") runAt = new Date(body.runAt);

    try {
      const { rows } = await pool.query(
        `INSERT INTO jobs (queue_id, type, payload, handler, priority, run_at, idempotency_key, max_attempts, depends_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [queueId, body.type, body.payload, body.handler, body.priority, runAt, body.idempotencyKey ?? null, body.maxAttempts ?? null, body.dependsOn, req.user!.id]
      );
      res.status(201).json({ data: rows[0] });
    } catch (err: any) {
      if (err.code === "23505") {
        // unique_violation on (queue_id, idempotency_key) — return the existing job instead of erroring.
        const { rows } = await pool.query(`SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2`, [
          queueId,
          body.idempotencyKey,
        ]);
        return res.status(200).json({ data: rows[0], deduplicated: true });
      }
      throw err;
    }
  })
);

// Batch job creation — many jobs in one request, grouped by a shared batch_id.
const batchSchema = z.object({
  jobs: z.array(z.object({ handler: z.string().min(1), payload: z.record(z.any()).default({}), priority: z.number().int().default(0) })).min(1).max(1000),
});

jobsRouter.post(
  "/queues/:queueId/jobs/batch",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const body = batchSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: batchRows } = await client.query(`SELECT gen_random_uuid() AS id`);
      const batchId = batchRows[0].id;
      const inserted = [];
      for (const j of body.jobs) {
        const { rows } = await client.query(
          `INSERT INTO jobs (queue_id, type, payload, handler, priority, batch_id) VALUES ($1,'immediate',$2,$3,$4,$5) RETURNING id`,
          [req.params.queueId, j.payload, j.handler, j.priority, batchId]
        );
        inserted.push(rows[0].id);
      }
      await client.query("COMMIT");
      res.status(201).json({ data: { batchId, jobIds: inserted } });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

jobsRouter.get(
  "/queues/:queueId/jobs",
  requireRole("viewer"),
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = paginationParams(req);
    const status = req.query.status as string | undefined;
    const conditions = ["queue_id = $1"];
    const values: unknown[] = [req.params.queueId];
    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    values.push(pageSize, offset);
    const { rows } = await pool.query(
      `SELECT * FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total FROM jobs WHERE ${conditions.join(" AND ")}`,
      values.slice(0, conditions.length)
    );
    res.json({ data: rows, page, pageSize, total: countRows[0].total });
  })
);

jobsRouter.get(
  "/jobs/:jobId",
  requireRole("viewer"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [req.params.jobId]);
    if (!rows.length) throw new ApiError(404, "NOT_FOUND", "Job not found");
    const { rows: executions } = await pool.query(
      `SELECT * FROM job_executions WHERE job_id = $1 ORDER BY attempt_number`,
      [req.params.jobId]
    );
    const { rows: logs } = await pool.query(`SELECT * FROM job_logs WHERE job_id = $1 ORDER BY created_at`, [
      req.params.jobId,
    ]);
    res.json({ data: { ...rows[0], executions, logs } });
  })
);

jobsRouter.post(
  "/jobs/:jobId/cancel",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued','scheduled','retrying') RETURNING *`,
      [req.params.jobId]
    );
    if (!rows.length) throw new ApiError(409, "CANNOT_CANCEL", "Job is not in a cancellable state");
    res.json({ data: rows[0] });
  })
);
