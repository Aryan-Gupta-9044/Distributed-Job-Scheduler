export type RetryStrategy = "fixed" | "linear" | "exponential";

export interface RetryPolicy {
  strategy: RetryStrategy;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * Computes the delay before the next retry attempt.
 * attempt = the attempt number that just failed (1-indexed).
 *
 *   fixed:       delay = base
 *   linear:      delay = base * attempt
 *   exponential: delay = base * 2^(attempt-1)
 *
 * Optional full jitter (AWS-style) is applied to avoid thundering-herd
 * retries against the same downstream dependency.
 */
export function computeNextDelayMs(policy: RetryPolicy, attempt: number): number {
  let delay: number;
  switch (policy.strategy) {
    case "fixed":
      delay = policy.baseDelayMs;
      break;
    case "linear":
      delay = policy.baseDelayMs * attempt;
      break;
    case "exponential":
    default:
      delay = policy.baseDelayMs * Math.pow(2, attempt - 1);
      break;
  }

  delay = Math.min(delay, policy.maxDelayMs);

  if (policy.jitter) {
    delay = Math.floor(Math.random() * delay);
  }

  return Math.max(delay, 0);
}

export function shouldMoveToDeadLetter(policy: RetryPolicy, attempt: number): boolean {
  return attempt >= policy.maxAttempts;
}
