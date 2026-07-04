import { describe, it, expect, vi } from "vitest";
import { computeNextDelayMs, shouldMoveToDeadLetter, RetryPolicy } from "../src/jobs-engine/retryPolicy.js";

const base = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  strategy: "exponential",
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 300000,
  jitter: false,
  ...overrides,
});

describe("computeNextDelayMs", () => {
  it("fixed strategy always returns the base delay", () => {
    const policy = base({ strategy: "fixed", baseDelayMs: 2000 });
    expect(computeNextDelayMs(policy, 1)).toBe(2000);
    expect(computeNextDelayMs(policy, 5)).toBe(2000);
  });

  it("linear strategy scales delay by attempt number", () => {
    const policy = base({ strategy: "linear", baseDelayMs: 1000 });
    expect(computeNextDelayMs(policy, 1)).toBe(1000);
    expect(computeNextDelayMs(policy, 3)).toBe(3000);
  });

  it("exponential strategy doubles each attempt", () => {
    const policy = base({ strategy: "exponential", baseDelayMs: 1000 });
    expect(computeNextDelayMs(policy, 1)).toBe(1000);
    expect(computeNextDelayMs(policy, 2)).toBe(2000);
    expect(computeNextDelayMs(policy, 4)).toBe(8000);
  });

  it("never exceeds maxDelayMs regardless of strategy", () => {
    const policy = base({ strategy: "exponential", baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(computeNextDelayMs(policy, 10)).toBe(5000);
  });

  it("with jitter enabled, delay is between 0 and the unjittered delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const policy = base({ strategy: "fixed", baseDelayMs: 4000, jitter: true });
    const delay = computeNextDelayMs(policy, 1);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(4000);
    vi.restoreAllMocks();
  });
});

describe("shouldMoveToDeadLetter", () => {
  it("returns false while attempts remain", () => {
    expect(shouldMoveToDeadLetter(base({ maxAttempts: 5 }), 3)).toBe(false);
  });

  it("returns true once attempts reach the max", () => {
    expect(shouldMoveToDeadLetter(base({ maxAttempts: 5 }), 5)).toBe(true);
  });

  it("returns true once attempts exceed the max", () => {
    expect(shouldMoveToDeadLetter(base({ maxAttempts: 5 }), 6)).toBe(true);
  });
});
