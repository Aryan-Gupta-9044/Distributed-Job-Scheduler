import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = fs.existsSync("/db/schema.sql")
    ? "/db/schema.sql" // inside Docker (see Dockerfile)
    : path.resolve(__dirname, "../../../db/schema.sql"); // local monorepo layout
  const sql = fs.readFileSync(schemaPath, "utf-8");
  console.log("Applying schema.sql ...");
  await pool.query(sql);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
