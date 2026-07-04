import { v4 as uuid } from "uuid";
import { redis } from "../realtime/redisClient.js";

/**
 * Minimal distributed lock built on Redis SET NX PX + a Lua compare-and-
 * delete unlock. Good enough for a single-Redis deployment; documented
 * in design-decisions.md as the place to swap in real Redlock (multiple
 * independent Redis nodes) if the system needs to tolerate a single
 * Redis instance failing mid-lock.
 *
 * Used for:
 *  - Cron scheduler leader election (only one instance materializes
 *    due `scheduled_jobs` into concrete `jobs` rows per tick).
 *  - Any other "exactly one node should do this" critical section.
 */
export class DistributedLock {
  private token: string | null = null;

  constructor(private key: string, private ttlMs: number = 10000) {}

  /** Try to acquire once. Returns true if acquired. */
  async tryAcquire(): Promise<boolean> {
    const token = uuid();
    const result = await redis.set(`lock:${this.key}`, token, "PX", this.ttlMs, "NX");
    if (result === "OK") {
      this.token = token;
      return true;
    }
    return false;
  }

  /** Extend TTL — call periodically while still holding the lock ("lease renewal"). */
  async renew(): Promise<boolean> {
    if (!this.token) return false;
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end`;
    const res = await redis.eval(script, 1, `lock:${this.key}`, this.token, String(this.ttlMs));
    return Number(res) === 1;
  }

  /** Release only if we still hold it (compare-and-delete avoids releasing someone else's lock). */
  async release(): Promise<void> {
    if (!this.token) return;
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end`;
    await redis.eval(script, 1, `lock:${this.key}`, this.token);
    this.token = null;
  }
}
