import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncHandler, ApiError } from "../utils/errors.js";
import { signToken } from "../middleware/auth.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  orgName: z.string().min(1),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [body.email]);
    if (existing.rows.length) throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists");

    const passwordHash = await bcrypt.hash(body.password, 10);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: userRows } = await client.query(
        `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name`,
        [body.email, passwordHash, body.name]
      );
      const user = userRows[0];
      const slug = body.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50) + "-" + Date.now().toString(36);
      const { rows: orgRows } = await client.query(
        `INSERT INTO organizations (name, slug, owner_id) VALUES ($1,$2,$3) RETURNING id, name, slug`,
        [body.orgName, slug, user.id]
      );
      const org = orgRows[0];
      await client.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, user.id]);
      await client.query("COMMIT");

      const token = signToken(user.id, user.email);
      res.status(201).json({ token, user, organization: org });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await pool.query(`SELECT id, email, password_hash, name FROM users WHERE email = $1`, [body.email]);
    if (!rows.length) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");

    const ok = await bcrypt.compare(body.password, rows[0].password_hash);
    if (!ok) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");

    const token = signToken(rows[0].id, rows[0].email);
    res.json({ token, user: { id: rows[0].id, email: rows[0].email, name: rows[0].name } });
  })
);
