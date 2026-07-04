import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/job_scheduler",
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 20),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",
  workerHeartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_MS ?? 5000),
  workerStaleAfterMs: Number(process.env.WORKER_STALE_MS ?? 20000),
  aiSummaryEnabled: process.env.AI_SUMMARY_ENABLED === "true",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
