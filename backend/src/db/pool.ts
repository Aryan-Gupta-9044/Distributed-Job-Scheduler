import pg from "pg";
import { config } from "../config/env.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  idleTimeoutMillis: 30000,
});

/** Run a query with an already-checked-out client (for transactions). */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
