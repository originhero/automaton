import { describe, expect, it } from "vitest";

import {
  BUILTIN_MODELS,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_ENV_VARS,
  type BuiltinModelEntry,
  type ModelTier,
  type ModelSource,
} from "../../inference/catalog/builtin-models.js";

const VALID_PROTOCOLS = ["openai-compatible", "anthropic", "google", "ollama"] as const;
const VALID_TIERS: ModelTier[] = ["frontier", "balanced", "economy", "local"];
const VALID_SOURCES: ModelSource[] = ["builtin", "discovered", "custom"];

describe("BUILTIN_MODELS catalog", () => {
  it("exports a non-empty array", () => {
    expect(Array.isArray(BUILTIN_MODELS)).toBe(true);
    expect(BUILTIN_MODELS.length).toBeGreaterThanOrEqual(20);
  });

  it("all entries have required string fields", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(typeof entry.modelId, `modelId on ${entry.modelId}`).toBe("string");
      expect(entry.modelId.length, `modelId empty on entry`).toBeGreaterThan(0);

      expect(typeof entry.provider, `provider on ${entry.modelId}`).toBe("string");
      expect(entry.provider.length, `provider empty on ${entry.modelId}`).toBeGreaterThan(0);

      expect(typeof entry.baseUrl, `baseUrl on ${entry.modelId}`).toBe("string");
      expect(entry.baseUrl.length, `baseUrl empty on ${entry.modelId}`).toBeGreaterThan(0);

      expect(typeof entry.displayName, `displayName on ${entry.modelId}`).toBe("string");
      expect(entry.displayName.length, `displayName empty on ${entry.modelId}`).toBeGreaterThan(0);
    }
  });

  it("all entries have a valid protocol", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(
        VALID_PROTOCOLS.includes(entry.protocol as (typeof VALID_PROTOCOLS)[number]),
        `invalid protocol "${entry.protocol}" on ${entry.modelId}`,
      ).toBe(true);
    }
  });

  it("all entries have a valid tier", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(
        VALID_TIERS.includes(entry.tier),
        `invalid tier "${entry.tier}" on ${entry.modelId}`,
      ).toBe(true);
    }
  });

  it("all entries have source set to 'builtin'", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(entry.source, `source on ${entry.modelId}`).toBe("builtin");
    }
  });

  it("all entries have non-negative numeric cost fields", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(typeof entry.costPer1kInput, `costPer1kInput on ${entry.modelId}`).toBe("number");
      expect(entry.costPer1kInput, `costPer1kInput negative on ${entry.modelId}`).toBeGreaterThanOrEqual(0);

      expect(typeof entry.costPer1kOutput, `costPer1kOutput on ${entry.modelId}`).toBe("number");
      expect(entry.costPer1kOutput, `costPer1kOutput negative on ${entry.modelId}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("all entries have positive contextWindow and maxOutputTokens", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(entry.contextWindow, `contextWindow on ${entry.modelId}`).toBeGreaterThan(0);
      expect(entry.maxOutputTokens, `maxOutputTokens on ${entry.modelId}`).toBeGreaterThan(0);
    }
  });

  it("all entries have boolean capability flags", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(typeof entry.supportsTools, `supportsTools on ${entry.modelId}`).toBe("boolean");
      expect(typeof entry.supportsVision, `supportsVision on ${entry.modelId}`).toBe("boolean");
      expect(typeof entry.supportsStreaming, `supportsStreaming on ${entry.modelId}`).toBe("boolean");
    }
  });

  it("all entries have a boolean enabled field", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(typeof entry.enabled, `enabled on ${entry.modelId}`).toBe("boolean");
    }
  });

  it("all modelIds are unique", () => {
    const ids = BUILTIN_MODELS.map((e) => e.modelId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("covers the required set of providers", () => {
    const providers = new Set(BUILTIN_MODELS.map((e) => e.provider));
    const required = ["openai", "anthropic", "google", "deepseek", "xai", "ollama"];
    for (const p of required) {
      expect(providers.has(p), `missing provider: ${p}`).toBe(true);
    }
  });

  it("covers all four tiers", () => {
    const tiers = new Set(BUILTIN_MODELS.map((e) => e.tier));
    for (const tier of VALID_TIERS) {
      expect(tiers.has(tier), `missing tier: ${tier}`).toBe(true);
    }
  });

  it("local-tier models have zero cost", () => {
    const localModels = BUILTIN_MODELS.filter((e) => e.tier === "local");
    expect(localModels.length).toBeGreaterThan(0);
    for (const entry of localModels) {
      expect(entry.costPer1kInput, `costPer1kInput should be 0 for ${entry.modelId}`).toBe(0);
      expect(entry.costPer1kOutput, `costPer1kOutput should be 0 for ${entry.modelId}`).toBe(0);
    }
  });

  it("baseUrl starts with http:// or https://", () => {
    for (const entry of BUILTIN_MODELS) {
      expect(
        entry.baseUrl.startsWith("http://") || entry.baseUrl.startsWith("https://"),
        `invalid baseUrl "${entry.baseUrl}" on ${entry.modelId}`,
      ).toBe(true);
    }
  });
});

describe("PROVIDER_DEFAULT_URLS", () => {
  it("is a non-empty record of strings", () => {
    expect(typeof PROVIDER_DEFAULT_URLS).toBe("object");
    expect(Object.keys(PROVIDER_DEFAULT_URLS).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(PROVIDER_DEFAULT_URLS)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(value.startsWith("http")).toBe(true);
    }
  });

  it("has an entry for every provider found in BUILTIN_MODELS", () => {
    const providers = new Set(BUILTIN_MODELS.map((e) => e.provider));
    for (const provider of providers) {
      expect(
        PROVIDER_DEFAULT_URLS[provider],
        `missing default URL for provider: ${provider}`,
      ).toBeDefined();
    }
  });
});

describe("PROVIDER_ENV_VARS", () => {
  it("is a non-empty record of strings", () => {
    expect(typeof PROVIDER_ENV_VARS).toBe("object");
    expect(Object.keys(PROVIDER_ENV_VARS).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(PROVIDER_ENV_VARS)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("does not include ollama (local models need no API key)", () => {
    expect(PROVIDER_ENV_VARS["ollama"]).toBeUndefined();
  });
});
