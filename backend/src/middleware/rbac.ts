import { Response, NextFunction } from "express";
import { pool } from "../db/pool.js";
import { ApiError } from "../utils/errors.js";
import { AuthedRequest } from "./auth.js";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

const RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Bonus feature: Role-Based Access Control.
 * Resolves the caller's role within the org that owns the resource
 * (derived from req.params.orgId, falling back to a project/queue/job
 * lookup chain when the route only has a nested id), and rejects the
 * request if the role is below `minRole`.
 */
export function requireRole(minRole: OrgRole) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      const orgId = await resolveOrgId(req);
      if (!orgId) return next(new ApiError(404, "NOT_FOUND", "Resource not found"));

      const { rows } = await pool.query(
        `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
        [orgId, req.user!.id]
      );
      if (rows.length === 0) {
        return next(new ApiError(403, "FORBIDDEN", "You are not a member of this organization"));
      }
      const role: OrgRole = rows[0].role;
      if (RANK[role] < RANK[minRole]) {
        return next(new ApiError(403, "FORBIDDEN", `Requires role >= ${minRole}, you have ${role}`));
      }
      (req as any).orgRole = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function resolveOrgId(req: AuthedRequest): Promise<string | null> {
  if (req.params.orgId) return req.params.orgId;
  if (req.body?.orgId) return req.body.orgId;

  if (req.params.projectId) {
    const { rows } = await pool.query(`SELECT org_id FROM projects WHERE id = $1`, [req.params.projectId]);
    return rows[0]?.org_id ?? null;
  }
  if (req.params.queueId) {
    const { rows } = await pool.query(
      `SELECT p.org_id FROM queues q JOIN projects p ON p.id = q.project_id WHERE q.id = $1`,
      [req.params.queueId]
    );
    return rows[0]?.org_id ?? null;
  }
  if (req.params.jobId) {
    const { rows } = await pool.query(
      `SELECT p.org_id FROM jobs j
         JOIN queues q ON q.id = j.queue_id
         JOIN projects p ON p.id = q.project_id
        WHERE j.id = $1`,
      [req.params.jobId]
    );
    return rows[0]?.org_id ?? null;
  }
  return null;
}
