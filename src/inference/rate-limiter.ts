/**
 * Token Bucket Rate Limiter
 *
 * Production-grade rate limiting for inference calls with:
 * - Token bucket algorithm (steady refill rate)
 * - Per-minute and per-hour limit enforcement
 * - Retry-After header parsing
 * - Exponential backoff with jitter
 * - Per-provider tracking
 * - Configurable via environment variables
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("rate-limiter");

export interface RateLimiterConfig {
  maxRequestsPerMinute: number;
  maxRequestsPerHour: number;
  retryAfterMs: number;
  maxRetries: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxRequestsPerMinute: 10,
  maxRequestsPerHour: 300,
  retryAfterMs: 5000,
  maxRetries: 3,
  backoffMultiplier: 2.0,
  maxBackoffMs: 60_000,
};

/**
 * Resolve rate limiter config from environment variables, falling back to defaults.
 */
export function resolveRateLimiterConfig(
  overrides?: Partial<RateLimiterConfig>,
): RateLimiterConfig {
  const envRpm = process.env.ORIGINHERO_MAX_RPM;
  const envRph = process.env.ORIGINHERO_MAX_RPH;

  return {
    ...DEFAULT_RATE_LIMITER_CONFIG,
    ...(envRpm && !isNaN(Number(envRpm)) ? { maxRequestsPerMinute: Number(envRpm) } : {}),
    ...(envRph && !isNaN(Number(envRph)) ? { maxRequestsPerHour: Number(envRph) } : {}),
    ...overrides,
  };
}

interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number; // tokens per millisecond
  lastRefill: number; // timestamp ms
}

interface HourlyWindow {
  count: number;
  windowStart: number; // timestamp ms
}

interface ProviderState {
  minuteBucket: TokenBucket;
  hourlyWindow: HourlyWindow;
  consecutiveFailures: number;
  retryAfterUntil: number; // timestamp ms — do not send requests before this
}

/**
 * Production-grade token bucket rate limiter for inference API calls.
 *
 * Each provider gets independent tracking with per-minute (token bucket)
 * and per-hour (sliding window) enforcement.
 */
export class InferenceRateLimiter {
  private config: RateLimiterConfig;
  private providers: Map<string, ProviderState> = new Map();

  /** Injected clock for testing; defaults to Date.now */
  private now: () => number;

  constructor(config?: Partial<RateLimiterConfig>, clock?: () => number) {
    this.config = resolveRateLimiterConfig(config);
    this.now = clock ?? (() => Date.now());
  }

  /**
   * Wait until a token is available for the given provider, then consume it.
   * Blocks the caller with an async delay when the bucket is empty or
   * a Retry-After window is active.
   */
  async waitForToken(provider = "default"): Promise<void> {
    const state = this.getOrCreateState(provider);
    let attempts = 0;

    while (true) {
      // 1. Respect Retry-After deadline
      const now = this.now();
      if (state.retryAfterUntil > now) {
        const waitMs = state.retryAfterUntil - now;
        logger.info(`Rate limiter: Retry-After active for ${provider}, waiting ${waitMs}ms`);
        await this.sleep(waitMs);
        continue;
      }

      // 2. Refill minute bucket
      this.refillBucket(state.minuteBucket);

      // 3. Check hourly window — reset if window has elapsed
      this.refreshHourlyWindow(state.hourlyWindow);

      // 4. Check both limits
      const minuteOk = state.minuteBucket.tokens >= 1;
      const hourlyOk = state.hourlyWindow.count < this.config.maxRequestsPerHour;

      if (minuteOk && hourlyOk) {
        // Consume one token from the minute bucket
        state.minuteBucket.tokens -= 1;
        // Increment hourly counter
        state.hourlyWindow.count += 1;
        return;
      }

      // 5. Calculate wait time
      let waitMs: number;
      if (!minuteOk) {
        // Wait for one token to refill
        waitMs = Math.ceil(1 / state.minuteBucket.refillRate);
      } else {
        // Hourly limit hit — wait until window resets
        const windowEnd = state.hourlyWindow.windowStart + 3_600_000;
        waitMs = Math.max(windowEnd - this.now(), 1000);
      }

      // Apply backoff with jitter if we've been waiting multiple attempts
      attempts++;
      if (attempts > 1) {
        const backoff = Math.min(
          waitMs * Math.pow(this.config.backoffMultiplier, attempts - 1),
          this.config.maxBackoffMs,
        );
        // Add jitter: +/- 20% of the backoff
        const jitter = backoff * 0.2 * (Math.random() * 2 - 1);
        waitMs = Math.max(Math.round(backoff + jitter), 100);
      }

      logger.info(
        `Rate limiter: bucket empty for ${provider}, waiting ${waitMs}ms (attempt ${attempts})`,
      );

      if (attempts > this.config.maxRetries + 2) {
        // Safety valve: after many attempts, wait the maximum backoff
        // and let the caller proceed (the API will 429 and recordFailure
        // will handle it).
        logger.warn(
          `Rate limiter: exceeded retry threshold for ${provider}, proceeding anyway`,
        );
        return;
      }

      await this.sleep(waitMs);
    }
  }

  /**
   * Record a successful request. Resets the consecutive failure counter.
   */
  recordSuccess(provider = "default"): void {
    const state = this.getOrCreateState(provider);
    state.consecutiveFailures = 0;
  }

  /**
   * Record a failed request. If retryAfterMs is provided (from a Retry-After
   * header), set a deadline before which no requests should be sent.
   * Otherwise, apply exponential backoff based on consecutive failure count.
   */
  recordFailure(provider = "default", retryAfterMs?: number): void {
    const state = this.getOrCreateState(provider);
    state.consecutiveFailures++;

    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      // Respect the exact Retry-After value from the server
      state.retryAfterUntil = this.now() + retryAfterMs;
      logger.info(
        `Rate limiter: Retry-After ${retryAfterMs}ms set for ${provider}`,
      );
    } else {
      // Exponential backoff with jitter
      const baseDelay = this.config.retryAfterMs;
      const backoff = Math.min(
        baseDelay * Math.pow(this.config.backoffMultiplier, state.consecutiveFailures - 1),
        this.config.maxBackoffMs,
      );
      const jitter = backoff * 0.2 * (Math.random() * 2 - 1);
      const delay = Math.max(Math.round(backoff + jitter), 100);

      state.retryAfterUntil = this.now() + delay;
      logger.info(
        `Rate limiter: backoff ${delay}ms set for ${provider} (failure #${state.consecutiveFailures})`,
      );
    }

    // Temporarily reduce the bucket to slow down subsequent requests
    state.minuteBucket.tokens = Math.max(state.minuteBucket.tokens - 1, 0);
  }

  /**
   * Parse a Retry-After header value into milliseconds.
   * Supports both delta-seconds ("120") and HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT").
   */
  static parseRetryAfter(headerValue: string | null | undefined): number | undefined {
    if (!headerValue) return undefined;

    const trimmed = headerValue.trim();

    // Try as integer seconds first
    const seconds = Number(trimmed);
    if (!isNaN(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }

    // Try as HTTP-date
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      const deltaMs = date.getTime() - Date.now();
      return Math.max(deltaMs, 0);
    }

    return undefined;
  }

  /**
   * Get current state snapshot for a provider (useful for diagnostics).
   */
  getProviderState(provider = "default"): {
    minuteTokens: number;
    hourlyCount: number;
    consecutiveFailures: number;
    retryAfterActive: boolean;
  } {
    const state = this.getOrCreateState(provider);
    this.refillBucket(state.minuteBucket);
    this.refreshHourlyWindow(state.hourlyWindow);
    return {
      minuteTokens: Math.floor(state.minuteBucket.tokens),
      hourlyCount: state.hourlyWindow.count,
      consecutiveFailures: state.consecutiveFailures,
      retryAfterActive: state.retryAfterUntil > this.now(),
    };
  }

  // ─── Internal ────────────────────────────────────────────────────

  private getOrCreateState(provider: string): ProviderState {
    let state = this.providers.get(provider);
    if (!state) {
      const now = this.now();
      state = {
        minuteBucket: {
          tokens: this.config.maxRequestsPerMinute,
          maxTokens: this.config.maxRequestsPerMinute,
          refillRate: this.config.maxRequestsPerMinute / 60_000, // tokens per ms
          lastRefill: now,
        },
        hourlyWindow: {
          count: 0,
          windowStart: now,
        },
        consecutiveFailures: 0,
        retryAfterUntil: 0,
      };
      this.providers.set(provider, state);
    }
    return state;
  }

  private refillBucket(bucket: TokenBucket): void {
    const now = this.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;

    const tokensToAdd = elapsed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.tokens + tokensToAdd, bucket.maxTokens);
    bucket.lastRefill = now;
  }

  private refreshHourlyWindow(window: HourlyWindow): void {
    const now = this.now();
    if (now - window.windowStart >= 3_600_000) {
      window.count = 0;
      window.windowStart = now;
    }
  }

  /** Overridable sleep for testing. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
