import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";

async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: userRows } = await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ('demo@example.com', $1, 'Demo Admin')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [passwordHash]
    );
    const userId = userRows[0].id;

    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug, owner_id) VALUES ('Demo Org', 'demo-org', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [userId]
    );
    const orgId = orgRows[0].id;
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
      [orgId, userId]
    );

    const { rows: projRows } = await client.query(
      `INSERT INTO projects (org_id, name, created_by) VALUES ($1,'Demo Project',$2)
       ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [orgId, userId]
    );
    const projectId = projRows[0].id;

    const { rows: policyRows } = await client.query(
      `INSERT INTO retry_policies (name, strategy, max_attempts, base_delay_ms, max_delay_ms, jitter)
       VALUES ('default-exponential','exponential',5,1000,300000,true) RETURNING id`
    );

    const { rows: queueRows } = await client.query(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit, rate_limit_per_sec, default_retry_policy_id)
       VALUES ($1,'emails',10,5,20,$2)
       ON CONFLICT (project_id, name) DO UPDATE SET priority = EXCLUDED.priority RETURNING id`,
      [projectId, policyRows[0].id]
    );
    const queueId = queueRows[0].id;

    for (let i = 0; i < 15; i++) {
      await client.query(
        `INSERT INTO jobs (queue_id, type, handler, payload, priority) VALUES ($1,'immediate','send-email',$2,$3)`,
        [queueId, JSON.stringify({ to: `user${i}@example.com` }), i % 3]
      );
    }
    // A couple of jobs that will deliberately fail, to demonstrate retry/DLQ.
    for (let i = 0; i < 3; i++) {
      await client.query(
        `INSERT INTO jobs (queue_id, type, handler, payload, max_attempts) VALUES ($1,'immediate','generate-report',$2,2)`,
        [queueId, JSON.stringify({ failureRate: 1 })]
      );
    }

    await client.query("COMMIT");
    console.log("Seed complete.");
    console.log(`Login: demo@example.com / password123`);
    console.log(`Queue id (for WORKER_QUEUE_ID): ${queueId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
