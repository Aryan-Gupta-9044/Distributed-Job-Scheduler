import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../utils/errors.js";
import { requireAuth, AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

orgsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rows } = await pool.query(
      `SELECT o.id, o.name, o.slug, m.role
         FROM organizations o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY o.created_at`,
      [req.user!.id]
    );
    res.json({ data: rows });
  })
);

const createProjectSchema = z.object({ name: z.string().min(1), description: z.string().optional() });

orgsRouter.post(
  "/:orgId/projects",
  requireRole("admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = createProjectSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO projects (org_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.orgId, body.name, body.description ?? null, req.user!.id]
    );
    res.status(201).json({ data: rows[0] });
  })
);

orgsRouter.get(
  "/:orgId/projects",
  requireRole("viewer"),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM projects WHERE org_id = $1 ORDER BY created_at DESC`, [
      req.params.orgId,
    ]);
    res.json({ data: rows });
  })
);

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(["admin", "member", "viewer"]) });

orgsRouter.post(
  "/:orgId/members",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const body = inviteSchema.parse(req.body);
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [body.email]);
    if (!userRows.length) {
      return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "No user with that email exists yet" } });
    }
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.params.orgId, userRows[0].id, body.role]
    );
    res.status(201).json({ data: { userId: userRows[0].id, role: body.role } });
  })
);
