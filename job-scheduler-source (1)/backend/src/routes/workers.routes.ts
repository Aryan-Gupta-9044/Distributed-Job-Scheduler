import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncHandler, ApiError } from "../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { claimJobs } from "../jobs-engine/claim.js";
import { reportResult } from "../jobs-engine/reportResult.js";
import { emitWorkerUpdate } from "../realtime/socket.js";

export const workersRouter = Router();
workersRouter.use(requireAuth);

const registerSchema = z.object({
  hostname: z.string(),
  pid: z.number().optional(),
  shardKey: z.string().optional(),
  maxConcurrency: z.number().int().positive().default(10),
  version: z.string().optional(),
});

workersRouter.post(
  "/workers/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO workers (hostname, pid, shard_key, max_concurrency, version) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [body.hostname, body.pid ?? null, body.shardKey ?? null, body.maxConcurrency, body.version ?? null]
    );
    res.status(201).json({ data: rows[0] });
  })
);

const heartbeatSchema = z.object({ activeJobCount: z.number().int().min(0), cpuLoad: z.number().optional(), memoryMb: z.number().optional() });

workersRouter.post(
  "/workers/:workerId/heartbeat",
  asyncHandler(async (req, res) => {
    const body = heartbeatSchema.parse(req.body);
    await pool.query(`UPDATE workers SET last_seen_at = now(), status = 'online' WHERE id = $1`, [req.params.workerId]);
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, active_job_count, cpu_load, memory_mb) VALUES ($1,$2,$3,$4)`,
      [req.params.workerId, body.activeJobCount, body.cpuLoad ?? null, body.memoryMb ?? null]
    );
    emitWorkerUpdate({ workerId: req.params.workerId, status: "online", activeJobCount: body.activeJobCount });
    res.json({ data: { ok: true } });
  })
);

const claimSchema = z.object({ queueId: z.string().uuid(), batchSize: z.number().int().positive().max(50).default(1) });

workersRouter.post(
  "/workers/:workerId/claim",
  asyncHandler(async (req, res) => {
    const body = claimSchema.parse(req.body);
    const jobs = await claimJobs(body.queueId, req.params.workerId, body.batchSize);
    res.json({ data: jobs });
  })
);

const resultSchema = z.object({
  jobId: z.string().uuid(),
  lockToken: z.string().uuid(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
  errorStack: z.string().optional(),
  durationMs: z.number().int().min(0),
});

workersRouter.post(
  "/workers/:workerId/report",
  asyncHandler(async (req, res) => {
    const body = resultSchema.parse(req.body);
    const result = await reportResult({ ...body, workerId: req.params.workerId });
    if (!result.accepted) {
      throw new ApiError(409, "STALE_CLAIM", "This worker no longer owns the job (lock token mismatch)");
    }
    res.json({ data: result });
  })
);

workersRouter.get(
  "/workers",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT w.*, (now() - w.last_seen_at) < interval '20 seconds' AS is_healthy
         FROM workers w ORDER BY w.started_at DESC`
    );
    res.json({ data: rows });
  })
);
