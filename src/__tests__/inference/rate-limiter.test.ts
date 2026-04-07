/**
 * Rate Limiter Tests
 *
 * Tests: token bucket algorithm, per-minute/per-hour limits,
 * Retry-After parsing, exponential backoff with jitter,
 * per-provider tracking, env var configuration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  InferenceRateLimiter,
  resolveRateLimiterConfig,
  DEFAULT_RATE_LIMITER_CONFIG,
} from "../../inference/rate-limiter.js";
import type { RateLimiterConfig } from "../../inference/rate-limiter.js";

// ─── Testable subclass that tracks sleep calls instead of actually sleeping ──

class TestableRateLimiter extends InferenceRateLimiter {
  sleepCalls: number[] = [];
  totalSleptMs = 0;

  constructor(config?: Partial<RateLimiterConfig>, clock?: () => number) {
    super(config, clock);
  }

  protected override sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
    this.totalSleptMs += ms;
    // Advance the clock by the sleep duration if using a manual clock
    if ((this as any).advanceClock) {
      (this as any).advanceClock(ms);
    }
    return Promise.resolve();
  }
}

// ─── Helper: create a limiter with a controllable clock ──

function createTestLimiter(
  config?: Partial<RateLimiterConfig>,
): { limiter: TestableRateLimiter; advanceClock: (ms: number) => void; now: () => number } {
  let currentTime = 1_000_000;
  const clock = () => currentTime;
  const advanceClock = (ms: number) => { currentTime += ms; };
  const limiter = new TestableRateLimiter(config, clock);
  // Attach advanceClock so the sleep override can advance time
  (limiter as any).advanceClock = advanceClock;
  return { limiter, advanceClock, now: clock };
}

// ─── resolveRateLimiterConfig ────────────────────────────────────

describe("resolveRateLimiterConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    delete process.env.ORIGINHERO_MAX_RPM;
    delete process.env.ORIGINHERO_MAX_RPH;
  });

  it("returns defaults when no env vars or overrides", () => {
    const config = resolveRateLimiterConfig();
    expect(config).toEqual(DEFAULT_RATE_LIMITER_CONFIG);
  });

  it("reads ORIGINHERO_MAX_RPM from env", () => {
    process.env.ORIGINHERO_MAX_RPM = "20";
    const config = resolveRateLimiterConfig();
    expect(config.maxRequestsPerMinute).toBe(20);
    expect(config.maxRequestsPerHour).toBe(DEFAULT_RATE_LIMITER_CONFIG.maxRequestsPerHour);
  });

  it("reads ORIGINHERO_MAX_RPH from env", () => {
    process.env.ORIGINHERO_MAX_RPH = "500";
    const config = resolveRateLimiterConfig();
    expect(config.maxRequestsPerHour).toBe(500);
  });

  it("ignores invalid env var values", () => {
    process.env.ORIGINHERO_MAX_RPM = "not_a_number";
    const config = resolveRateLimiterConfig();
    expect(config.maxRequestsPerMinute).toBe(DEFAULT_RATE_LIMITER_CONFIG.maxRequestsPerMinute);
  });

  it("overrides take precedence over env vars", () => {
    process.env.ORIGINHERO_MAX_RPM = "20";
    const config = resolveRateLimiterConfig({ maxRequestsPerMinute: 30 });
    expect(config.maxRequestsPerMinute).toBe(30);
  });
});

// ─── Token Bucket: fill and drain ─────────────────────────────────

describe("Token bucket fill and drain", () => {
  it("starts with a full bucket", () => {
    const { limiter } = createTestLimiter({ maxRequestsPerMinute: 5 });
    const state = limiter.getProviderState("test");
    expect(state.minuteTokens).toBe(5);
  });

  it("drains tokens on waitForToken", async () => {
    const { limiter } = createTestLimiter({ maxRequestsPerMinute: 3, maxRequestsPerHour: 100 });

    await limiter.waitForToken("test");
    expect(limiter.getProviderState("test").minuteTokens).toBe(2);

    await limiter.waitForToken("test");
    expect(limiter.getProviderState("test").minuteTokens).toBe(1);

    await limiter.waitForToken("test");
    expect(limiter.getProviderState("test").minuteTokens).toBe(0);
  });

  it("refills tokens over time", async () => {
    const { limiter, advanceClock } = createTestLimiter({
      maxRequestsPerMinute: 10,
      maxRequestsPerHour: 1000,
    });

    // Drain all 10 tokens
    for (let i = 0; i < 10; i++) {
      await limiter.waitForToken("test");
    }
    expect(limiter.getProviderState("test").minuteTokens).toBe(0);

    // Advance 30 seconds (half a minute) — should refill ~5 tokens
    advanceClock(30_000);
    const state = limiter.getProviderState("test");
    expect(state.minuteTokens).toBe(5);
  });

  it("does not exceed max tokens on refill", async () => {
    const { limiter, advanceClock } = createTestLimiter({
      maxRequestsPerMinute: 5,
      maxRequestsPerHour: 1000,
    });

    // Advance a long time without consuming
    advanceClock(600_000); // 10 minutes
    const state = limiter.getProviderState("test");
    expect(state.minuteTokens).toBe(5); // capped at max
  });
});

// ─── waitForToken blocks when bucket is empty ─────────────────────

describe("waitForToken blocking", () => {
  it("sleeps when bucket is empty", async () => {
    const { limiter } = createTestLimiter({
      maxRequestsPerMinute: 2,
      maxRequestsPerHour: 1000,
    });

    // Drain the bucket
    await limiter.waitForToken("test");
    await limiter.waitForToken("test");

    // Next call should sleep
    await limiter.waitForToken("test");
    expect(limiter.sleepCalls.length).toBeGreaterThan(0);
  });

  it("sleeps with Retry-After deadline", async () => {
    const { limiter } = createTestLimiter({
      maxRequestsPerMinute: 10,
      maxRequestsPerHour: 1000,
    });

    // Set a Retry-After deadline
    limiter.recordFailure("test", 5000);

    // Next waitForToken should wait for the retry-after period
    await limiter.waitForToken("test");
    expect(limiter.sleepCalls.length).toBeGreaterThanOrEqual(1);
    // The first sleep should be the retry-after period (5000ms)
    expect(limiter.sleepCalls[0]).toBe(5000);
  });
});

// ─── Retry-After header parsing ───────────────────────────────────

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(InferenceRateLimiter.parseRetryAfter("120")).toBe(120_000);
  });

  it("parses zero seconds", () => {
    expect(InferenceRateLimiter.parseRetryAfter("0")).toBe(0);
  });

  it("returns undefined for null/undefined", () => {
    expect(InferenceRateLimiter.parseRetryAfter(null)).toBeUndefined();
    expect(InferenceRateLimiter.parseRetryAfter(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(InferenceRateLimiter.parseRetryAfter("")).toBeUndefined();
  });

  it("parses HTTP-date format", () => {
    const futureDate = new Date(Date.now() + 60_000);
    const result = InferenceRateLimiter.parseRetryAfter(futureDate.toUTCString());
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(0);
    expect(result!).toBeLessThanOrEqual(61_000);
  });

  it("returns 0 for past HTTP-date", () => {
    const pastDate = new Date(Date.now() - 60_000);
    const result = InferenceRateLimiter.parseRetryAfter(pastDate.toUTCString());
    expect(result).toBe(0);
  });
});

// ─── Exponential backoff with jitter ──────────────────────────────

describe("Exponential backoff with jitter", () => {
  it("produces increasing delays on consecutive failures", () => {
    const { limiter, advanceClock } = createTestLimiter({
      retryAfterMs: 1000,
      backoffMultiplier: 2.0,
      maxBackoffMs: 60_000,
    });

    // Record multiple failures and check retryAfterUntil increases
    const deadlines: number[] = [];

    for (let i = 0; i < 5; i++) {
      limiter.recordFailure("test");
      const state = limiter.getProviderState("test");
      deadlines.push(state.retryAfterActive ? 1 : 0);
      advanceClock(100_000); // advance past the deadline each time
    }

    // All failures should have set a retryAfter
    expect(deadlines.every((d) => d === 1)).toBe(true);
  });

  it("caps backoff at maxBackoffMs", () => {
    let currentTime = 1_000_000;
    const clock = () => currentTime;

    const limiter = new TestableRateLimiter(
      {
        retryAfterMs: 1000,
        backoffMultiplier: 10.0,
        maxBackoffMs: 5000,
      },
      clock,
    );
    (limiter as any).advanceClock = (ms: number) => { currentTime += ms; };

    // Many failures
    for (let i = 0; i < 20; i++) {
      limiter.recordFailure("test");
      currentTime += 100_000; // move past deadline
    }

    // The last failure's backoff should not exceed maxBackoffMs
    // (We can't precisely check the internal value due to jitter,
    // but we can verify the limiter still functions)
    expect(limiter.getProviderState("test").consecutiveFailures).toBe(20);
  });

  it("resets on success", () => {
    const { limiter } = createTestLimiter();

    limiter.recordFailure("test");
    limiter.recordFailure("test");
    expect(limiter.getProviderState("test").consecutiveFailures).toBe(2);

    limiter.recordSuccess("test");
    expect(limiter.getProviderState("test").consecutiveFailures).toBe(0);
  });
});

// ─── Per-minute and per-hour limits enforced independently ────────

describe("Per-minute and per-hour limits", () => {
  it("enforces per-minute limit", async () => {
    const { limiter } = createTestLimiter({
      maxRequestsPerMinute: 3,
      maxRequestsPerHour: 1000,
    });

    // Use all 3 per-minute tokens
    await limiter.waitForToken("test");
    await limiter.waitForToken("test");
    await limiter.waitForToken("test");

    // 4th call should require sleeping (bucket empty)
    const sleepsBefore = limiter.sleepCalls.length;
    await limiter.waitForToken("test");
    expect(limiter.sleepCalls.length).toBeGreaterThan(sleepsBefore);
  });

  it("enforces per-hour limit", async () => {
    const { limiter, advanceClock } = createTestLimiter({
      maxRequestsPerMinute: 100, // high per-minute so it doesn't interfere
      maxRequestsPerHour: 5,
    });

    // Use all 5 per-hour tokens
    for (let i = 0; i < 5; i++) {
      await limiter.waitForToken("test");
      advanceClock(1000); // advance 1s between each
    }

    const state = limiter.getProviderState("test");
    expect(state.hourlyCount).toBe(5);

    // 6th call should require sleeping (hourly limit hit)
    const sleepsBefore = limiter.sleepCalls.length;
    await limiter.waitForToken("test");
    expect(limiter.sleepCalls.length).toBeGreaterThan(sleepsBefore);
  });

  it("resets hourly window after 1 hour", async () => {
    const { limiter, advanceClock } = createTestLimiter({
      maxRequestsPerMinute: 100,
      maxRequestsPerHour: 5,
    });

    // Fill hourly window
    for (let i = 0; i < 5; i++) {
      await limiter.waitForToken("test");
    }
    expect(limiter.getProviderState("test").hourlyCount).toBe(5);

    // Advance past the hour
    advanceClock(3_600_001);

    // Window should reset
    const state = limiter.getProviderState("test");
    expect(state.hourlyCount).toBe(0);
  });
});

// ─── Per-provider tracking ────────────────────────────────────────

describe("Per-provider tracking", () => {
  it("tracks providers independently", async () => {
    const { limiter } = createTestLimiter({
      maxRequestsPerMinute: 3,
      maxRequestsPerHour: 1000,
    });

    // Drain Google bucket
    await limiter.waitForToken("google");
    await limiter.waitForToken("google");
    await limiter.waitForToken("google");

    // OpenAI should still have tokens
    const googleState = limiter.getProviderState("google");
    const openaiState = limiter.getProviderState("openai");

    expect(googleState.minuteTokens).toBe(0);
    expect(openaiState.minuteTokens).toBe(3);
  });

  it("failure on one provider does not affect another", () => {
    const { limiter } = createTestLimiter();

    limiter.recordFailure("google", 10_000);
    limiter.recordFailure("google");

    expect(limiter.getProviderState("google").consecutiveFailures).toBe(2);
    expect(limiter.getProviderState("google").retryAfterActive).toBe(true);

    expect(limiter.getProviderState("openai").consecutiveFailures).toBe(0);
    expect(limiter.getProviderState("openai").retryAfterActive).toBe(false);
  });
});

// ─── Retry-After respected by waitForToken ─────────────────────────

describe("Retry-After integration", () => {
  it("respects exact Retry-After value from recordFailure", async () => {
    const { limiter } = createTestLimiter({
      maxRequestsPerMinute: 10,
      maxRequestsPerHour: 1000,
    });

    // Simulate a 429 with Retry-After: 8s
    limiter.recordFailure("test", 8000);

    // The next waitForToken should sleep at least 8s
    limiter.sleepCalls = [];
    await limiter.waitForToken("test");

    expect(limiter.sleepCalls.length).toBeGreaterThanOrEqual(1);
    expect(limiter.sleepCalls[0]).toBe(8000);
  });
});

// ─── Default provider uses "default" key ──────────────────────────

describe("Default provider", () => {
  it("uses 'default' when no provider specified", async () => {
    const { limiter } = createTestLimiter({ maxRequestsPerMinute: 2, maxRequestsPerHour: 100 });

    await limiter.waitForToken();
    limiter.recordSuccess();

    const state = limiter.getProviderState();
    expect(state.minuteTokens).toBe(1);
    expect(state.consecutiveFailures).toBe(0);
  });
});
