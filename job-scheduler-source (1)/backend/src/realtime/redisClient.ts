import { Redis } from "ioredis";
import { config } from "../config/env.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("error", (err: Error) => {
  // eslint-disable-next-line no-console
  console.error("[redis] connection error:", err.message);
});
