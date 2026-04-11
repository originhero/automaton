/**
 * Regression test for bug H1 — API keys must not leak to child processes
 * via process.env after the agent loop boots.
 *
 * Contract under test:
 *   1. `ProviderRegistry.captureApiKeys()` copies all currently-set provider
 *      API keys from `process.env` into an in-memory cache.
 *   2. After capturing, the caller can delete the env vars, and
 *      `resolveApiKey()` still returns the captured value from the cache.
 *   3. `getCapturedEnvVarNames()` returns only the env var names for
 *      providers that had a value at capture time.
 *
 * This test defends the fix applied in Phase 2 (`loop.ts` + `provider-registry.ts`)
 * and would fail if:
 *   - The key cache is bypassed (e.g. `resolveApiKey` reads process.env first)
 *   - `captureApiKeys` is a no-op or only captures a subset
 *   - `getCapturedEnvVarNames` leaks providers that never had a key
 *
 * Related: docs/AUDIT-REPORT.md bug H1.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ProviderRegistry,
  type ProviderConfig,
  type ModelConfig,
} from "../inference/provider-registry.js";
import {
  captureAndScrubProviderKeys,
  ENV_KEYS_KEPT_AFTER_SCRUB,
} from "../agent/loop.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function mockModel(id: string): ModelConfig {
  return {
    id,
    tier: "fast",
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    costPerInputToken: 0,
    costPerOutputToken: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  };
}

function mockProvider(id: string, envVar: string): ProviderConfig {
  return {
    id,
    name: `mock-${id}`,
    baseUrl: "https://example.invalid/v1",
    apiKeyEnvVar: envVar,
    models: [mockModel(`${id}-model-1`)],
    maxRequestsPerMinute: 100,
    maxTokensPerMinute: 100_000,
    priority: 1,
    enabled: true,
  };
}

// Snapshot relevant env vars so we can restore them after each test
const RELEVANT_ENV_VARS = [
  "TEST_OPENAI_KEY",
  "TEST_ANTHROPIC_KEY",
  "TEST_NEVER_SET_KEY",
];

describe("H1 regression — ProviderRegistry key capture + scrub", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of RELEVANT_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of RELEVANT_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("captureApiKeys copies currently-set env vars into the in-memory cache", () => {
    process.env.TEST_OPENAI_KEY = "sk-test-openai-123";
    process.env.TEST_ANTHROPIC_KEY = "sk-test-anthropic-456";

    const registry = new ProviderRegistry([
      mockProvider("openai", "TEST_OPENAI_KEY"),
      mockProvider("anthropic", "TEST_ANTHROPIC_KEY"),
    ]);

    registry.captureApiKeys();

    const captured = registry.getCapturedEnvVarNames().sort();
    expect(captured).toEqual(["TEST_ANTHROPIC_KEY", "TEST_OPENAI_KEY"]);
  });

  it("resolveApiKey still returns the captured value after env var is deleted", () => {
    process.env.TEST_OPENAI_KEY = "sk-test-openai-scrubbed";

    const provider = mockProvider("openai", "TEST_OPENAI_KEY");
    const registry = new ProviderRegistry([provider]);

    registry.captureApiKeys();

    // Simulate the agent loop's scrub step
    delete process.env.TEST_OPENAI_KEY;

    // Access private method via type cast — test needs to verify the internal
    // contract that resolveApiKey prefers cache over env. This is intentional.
    const resolved = (registry as unknown as {
      resolveApiKey: (p: ProviderConfig) => string;
    }).resolveApiKey(provider);

    expect(resolved).toBe("sk-test-openai-scrubbed");
  });

  /**
   * Gap 2 fix (audit follow-up): this test codifies the actual security
   * property — cache has ABSOLUTE PRECEDENCE over process.env, not just
   * "cache survives delete". If a future refactor swaps the lookup order
   * (e.g. `process.env[envVar] ?? cached` instead of `cached ?? process.env`),
   * the "delete + resolve" test would still pass but this one fails.
   *
   * The scenario: after capture, another process (child, malicious code,
   * test pollution) restores the env var to a DIFFERENT value. The
   * registry must still serve the originally-captured key — otherwise
   * an attacker who can write to process.env can swap API keys
   * mid-execution and redirect traffic to their own endpoint.
   */
  it("resolveApiKey gives cache absolute precedence over a subsequently-modified env var", () => {
    process.env.TEST_OPENAI_KEY = "sk-original-legit";

    const provider = mockProvider("openai", "TEST_OPENAI_KEY");
    const registry = new ProviderRegistry([provider]);

    registry.captureApiKeys();

    // Attacker or buggy code writes a different value to the same env var.
    process.env.TEST_OPENAI_KEY = "sk-attacker-redirect";

    const resolved = (registry as unknown as {
      resolveApiKey: (p: ProviderConfig) => string;
    }).resolveApiKey(provider);

    // Must return the originally-captured value, not the tampered env var.
    expect(resolved).toBe("sk-original-legit");
    expect(resolved).not.toBe("sk-attacker-redirect");
  });

  it("captureApiKeys ignores empty-string env vars (treats as unset)", () => {
    // Edge case: `FOO=""` is technically set but has zero length.
    // The `value.length > 0` guard should skip it.
    process.env.TEST_OPENAI_KEY = "";

    const registry = new ProviderRegistry([
      mockProvider("openai", "TEST_OPENAI_KEY"),
    ]);

    registry.captureApiKeys();

    const captured = registry.getCapturedEnvVarNames();
    expect(captured).not.toContain("TEST_OPENAI_KEY");
  });

  it("getCapturedEnvVarNames does not return env vars that were unset at capture time", () => {
    process.env.TEST_OPENAI_KEY = "sk-test";
    // TEST_NEVER_SET_KEY intentionally unset

    const registry = new ProviderRegistry([
      mockProvider("openai", "TEST_OPENAI_KEY"),
      mockProvider("ghost", "TEST_NEVER_SET_KEY"),
    ]);

    registry.captureApiKeys();

    const captured = registry.getCapturedEnvVarNames();
    expect(captured).toContain("TEST_OPENAI_KEY");
    expect(captured).not.toContain("TEST_NEVER_SET_KEY");
  });

  it("resolveApiKey throws a clear error when the key is neither cached nor in env", () => {
    // No env var set, no capture — the fix for bug H11 requires a throw
    // with a descriptive message, not a placeholder string.
    const provider = mockProvider("openai", "TEST_NEVER_SET_KEY");
    const registry = new ProviderRegistry([provider]);

    expect(() => {
      (registry as unknown as {
        resolveApiKey: (p: ProviderConfig) => string;
      }).resolveApiKey(provider);
    }).toThrow(/TEST_NEVER_SET_KEY/);
  });

  it("captureApiKeys is idempotent — calling twice does not duplicate entries", () => {
    process.env.TEST_OPENAI_KEY = "sk-test";

    const registry = new ProviderRegistry([
      mockProvider("openai", "TEST_OPENAI_KEY"),
    ]);

    registry.captureApiKeys();
    registry.captureApiKeys();

    const captured = registry.getCapturedEnvVarNames();
    expect(captured).toEqual(["TEST_OPENAI_KEY"]);
  });
});

/**
 * Gap 5 fix (audit follow-up): the first describe block tests the
 * ProviderRegistry side of the contract. This block tests the loop.ts
 * side — that `captureAndScrubProviderKeys` actually DELETES the env
 * vars from `process.env` after capture. A refactor that removes the
 * delete would pass every test in the first block because the registry
 * still works. This block catches it.
 */
describe("H1 regression — captureAndScrubProviderKeys (loop.ts side)", () => {
  const testVars = [
    "TEST_OPENAI_KEY",
    "TEST_ANTHROPIC_KEY",
    "CONWAY_API_KEY",
    "OPENAI_BASE_URL",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of testVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of testVars) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("deletes provider env vars from process.env after capture", () => {
    process.env.TEST_OPENAI_KEY = "sk-test-openai";
    process.env.TEST_ANTHROPIC_KEY = "sk-test-anthropic";

    const registry = new ProviderRegistry([
      mockProvider("openai", "TEST_OPENAI_KEY"),
      mockProvider("anthropic", "TEST_ANTHROPIC_KEY"),
    ]);

    captureAndScrubProviderKeys(registry);

    // Both env vars must be GONE from process.env after scrub.
    expect(process.env.TEST_OPENAI_KEY).toBeUndefined();
    expect(process.env.TEST_ANTHROPIC_KEY).toBeUndefined();
  });

  it("still resolves the keys from the registry cache after scrubbing env", () => {
    process.env.TEST_OPENAI_KEY = "sk-test-openai-scrubbed";

    const provider = mockProvider("openai", "TEST_OPENAI_KEY");
    const registry = new ProviderRegistry([provider]);

    captureAndScrubProviderKeys(registry);

    // Env is scrubbed
    expect(process.env.TEST_OPENAI_KEY).toBeUndefined();

    // But cache still has the value
    const resolved = (registry as unknown as {
      resolveApiKey: (p: ProviderConfig) => string;
    }).resolveApiKey(provider);
    expect(resolved).toBe("sk-test-openai-scrubbed");
  });

  it("keeps CONWAY_API_KEY and OPENAI_BASE_URL in process.env (explicit exceptions)", () => {
    // The scrub logic has a whitelist of env vars that must NOT be deleted
    // because other subsystems read them directly.
    process.env.CONWAY_API_KEY = "conway-key-value";
    process.env.OPENAI_BASE_URL = "https://api.conway.tech/v1";

    const registry = new ProviderRegistry([
      mockProvider("conway", "CONWAY_API_KEY"),
    ]);

    captureAndScrubProviderKeys(registry);

    // CONWAY_API_KEY must still be present after scrub
    expect(process.env.CONWAY_API_KEY).toBe("conway-key-value");
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.conway.tech/v1");
  });

  it("exports the kept-keys whitelist as an explicit, auditable constant", () => {
    // Lock in the whitelist contents. If someone adds a new exception,
    // they must update this test — making the exception visible in PR
    // review instead of sneaking into the scrub loop.
    expect(ENV_KEYS_KEPT_AFTER_SCRUB.has("CONWAY_API_KEY")).toBe(true);
    expect(ENV_KEYS_KEPT_AFTER_SCRUB.has("OPENAI_BASE_URL")).toBe(true);
    // And it should NOT contain any common provider secret
    expect(ENV_KEYS_KEPT_AFTER_SCRUB.has("OPENAI_API_KEY")).toBe(false);
    expect(ENV_KEYS_KEPT_AFTER_SCRUB.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(ENV_KEYS_KEPT_AFTER_SCRUB.has("GOOGLE_API_KEY")).toBe(false);
    expect(ENV_KEYS_KEPT_AFTER_SCRUB.has("DEEPSEEK_API_KEY")).toBe(false);
  });

  it("is a no-op on env vars that were never captured", () => {
    // Pre-existing env var that's not a provider — must not be touched.
    process.env.UNRELATED_VAR = "should-survive";

    const registry = new ProviderRegistry([]);
    captureAndScrubProviderKeys(registry);

    expect(process.env.UNRELATED_VAR).toBe("should-survive");
    delete process.env.UNRELATED_VAR;
  });
});
