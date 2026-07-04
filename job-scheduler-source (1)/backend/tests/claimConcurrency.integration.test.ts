import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * This is a real integration test against Postgres + Redis — it proves
 * the actual guarantee the whole system depends on: with N workers
 * racing to claim from the same queue, every job is claimed by exactly
 * one worker, never zero, never two.
 *
 * It's guarded behind RUN_INTEGRATION=1 because it needs a live DB/Redis
 * (see README "Running tests"). This mirrors how you'd gate slow/infra-
 * dependent tests in CI vs. the fast unit suite that runs on every commit.
 */
const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("claimJobs concurrency", () => {
  let pool: any, queueId: string, workerIds: string[];

  beforeAll(async () => {
    const { pool: p } = await import("../src/db/pool.js");
    pool = p;

    const org = await pool.query(`INSERT INTO organizations (name, slug, owner_id)
      VALUES ('t','t-${Date.now()}', (SELECT id FROM users LIMIT 1)) RETURNING id`);
    const project = await pool.query(`INSERT INTO projects (org_id, name) VALUES ($1,'p') RETURNING id`, [org.rows[0].id]);
    const queue = await pool.query(
      `INSERT INTO queues (project_id, name, concurrency_limit) VALUES ($1,'q',100) RETURNING id`,
      [project.rows[0].id]
    );
    queueId = queue.rows[0].id;

    for (let i = 0; i < 20; i++) {
      await pool.query(`INSERT INTO jobs (queue_id, handler, payload) VALUES ($1,'noop','{}')`, [queueId]);
    }

    const workers = await Promise.all(
      Array.from({ length: 5 }).map(() => pool.query(`INSERT INTO workers (hostname) VALUES ('w') RETURNING id`))
    );
    workerIds = workers.map((w) => w.rows[0].id);
  });

  it("claims each job exactly once across 5 concurrent workers", async () => {
    const { claimJobs } = await import("../src/jobs-engine/claim.js");

    // Every worker races to claim from the same queue at the same time.
    const results = await Promise.all(workerIds.map((wid) => claimJobs(queueId, wid, 10)));
    const allClaimed = results.flat().map((j) => j.id);

    expect(allClaimed.length).toBe(20); // all jobs claimed
    expect(new Set(allClaimed).size).toBe(20); // no duplicates — no job claimed twice
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    await pool.end();
  });
});
