import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, ApiError, paginationParams } from "../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

export const dlqRouter = Router();
dlqRouter.use(requireAuth);

dlqRouter.get(
  "/queues/:queueId/dlq",
  requireRole("viewer"),
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = paginationParams(req);
    const { rows } = await pool.query(
      `SELECT * FROM dead_letter_queue WHERE queue_id = $1 ORDER BY moved_at DESC LIMIT $2 OFFSET $3`,
      [req.params.queueId, pageSize, offset]
    );
    res.json({ data: rows, page, pageSize });
  })
);

// Manual replay: re-queues the original job payload/handler as a brand new job.
dlqRouter.post(
  "/dlq/:dlqId/replay",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM dead_letter_queue WHERE id = $1`, [req.params.dlqId]);
    if (!rows.length) throw new ApiError(404, "NOT_FOUND", "DLQ entry not found");
    const entry = rows[0];

    const { rows: newJob } = await pool.query(
      `INSERT INTO jobs (queue_id, type, payload, handler, priority) VALUES ($1,'immediate',$2,$3,0) RETURNING *`,
      [entry.queue_id, entry.payload, entry.handler]
    );
    await pool.query(`UPDATE dead_letter_queue SET resolved = TRUE, resolved_at = now() WHERE id = $1`, [req.params.dlqId]);
    res.status(201).json({ data: newJob[0] });
  })
);
