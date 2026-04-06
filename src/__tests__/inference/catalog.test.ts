import { describe, it, expect, vi } from "vitest";
import { BUILTIN_MODELS, PROVIDER_DEFAULT_URLS, PROVIDER_ENV_VARS } from "../../inference/catalog/builtin-models.js";
import { PricingUpdater, type PricingData, type ModelPricingTarget } from "../../inference/catalog/pricing-updater.js";
import type { FetchFn } from "../../inference/protocols/types.js";

describe("Builtin Model Catalog", () => {
  it("contains at least 15 models", () => {
    expect(BUILTIN_MODELS.length).toBeGreaterThanOrEqual(15);
  });

  it("every model has all required fields", () => {
    for (const model of BUILTIN_MODELS) {
      expect(model.modelId).toBeTruthy();
      expect(model.provider).toBeTruthy();
      expect(["openai-compatible", "anthropic", "google", "ollama"]).toContain(model.protocol);
      expect(model.baseUrl).toBeTruthy();
      expect(model.displayName).toBeTruthy();
      expect(["frontier", "balanced", "economy", "local"]).toContain(model.tier);
      expect(typeof model.costPer1kInput).toBe("number");
      expect(typeof model.costPer1kOutput).toBe("number");
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
      expect(typeof model.supportsTools).toBe("boolean");
      expect(typeof model.supportsVision).toBe("boolean");
      expect(typeof model.supportsStreaming).toBe("boolean");
      expect(model.source).toBe("builtin");
      expect(model.enabled).toBe(true);
    }
  });

  it("has no duplicate modelIds", () => {
    const ids = BUILTIN_MODELS.map(m => m.modelId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("covers OpenAI, Anthropic, Google, DeepSeek, xAI providers", () => {
    const providers = new Set(BUILTIN_MODELS.map(m => m.provider));
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("google")).toBe(true);
    expect(providers.has("deepseek")).toBe(true);
    expect(providers.has("xai")).toBe(true);
  });

  it("has at least one model per tier", () => {
    const tiers = new Set(BUILTIN_MODELS.map(m => m.tier));
    expect(tiers.has("frontier")).toBe(true);
    expect(tiers.has("balanced")).toBe(true);
    expect(tiers.has("economy")).toBe(true);
    expect(tiers.has("local")).toBe(true);
  });

  it("Ollama models have zero cost", () => {
    const ollamaModels = BUILTIN_MODELS.filter(m => m.protocol === "ollama");
    for (const model of ollamaModels) {
      expect(model.costPer1kInput).toBe(0);
      expect(model.costPer1kOutput).toBe(0);
    }
  });

  it("PROVIDER_DEFAULT_URLS covers all providers with builtin models", () => {
    const providers = new Set(BUILTIN_MODELS.map(m => m.provider));
    for (const provider of providers) {
      expect(PROVIDER_DEFAULT_URLS[provider]).toBeTruthy();
    }
  });
});

describe("PricingUpdater", () => {
  it("fetches and parses pricing data", async () => {
    const pricingData: PricingData = {
      version: 1,
      updatedAt: "2026-04-06T00:00:00Z",
      models: {
        "gpt-4o": { costPer1kInput: 260, costPer1kOutput: 1050 },
      },
    };

    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(pricingData),
    } as Response);

    const updater = new PricingUpdater({ fetchFn, pricingUrl: "https://example.com/pricing.json" });
    const data = await updater.fetchPricing();

    expect(data).toBeDefined();
    expect(data!.models["gpt-4o"].costPer1kInput).toBe(260);
  });

  it("returns null on network error (silent fail)", async () => {
    const fetchFn: FetchFn = vi.fn().mockRejectedValue(new Error("Network error"));

    const updater = new PricingUpdater({ fetchFn });
    const data = await updater.fetchPricing();

    expect(data).toBeNull();
  });

  it("returns null on non-OK response", async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const updater = new PricingUpdater({ fetchFn });
    const data = await updater.fetchPricing();

    expect(data).toBeNull();
  });

  it("merges pricing and skips custom models", async () => {
    const pricingData: PricingData = {
      version: 1,
      updatedAt: "2026-04-06T00:00:00Z",
      models: {
        "gpt-4o": { costPer1kInput: 260, costPer1kOutput: 1050 },
        "my-custom": { costPer1kInput: 999, costPer1kOutput: 999 },
      },
    };

    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(pricingData),
    } as Response);

    const models: ModelPricingTarget[] = [
      { modelId: "gpt-4o", source: "builtin", costPer1kInput: 250, costPer1kOutput: 1000 },
      { modelId: "my-custom", source: "custom", costPer1kInput: 100, costPer1kOutput: 200 },
    ];

    const onUpdate = vi.fn();
    const updater = new PricingUpdater({ fetchFn, pricingUrl: "https://example.com/pricing.json" });
    const updated = await updater.updatePricing(models, onUpdate);

    // gpt-4o should be updated (builtin, prices differ)
    expect(updated).toContain("gpt-4o");
    expect(onUpdate).toHaveBeenCalledWith("gpt-4o", { costPer1kInput: 260, costPer1kOutput: 1050 });

    // my-custom should NOT be updated (custom source)
    expect(updated).not.toContain("my-custom");
  });

  it("does not call onUpdate when prices match", async () => {
    const pricingData: PricingData = {
      version: 1,
      updatedAt: "2026-04-06T00:00:00Z",
      models: {
        "gpt-4o": { costPer1kInput: 250, costPer1kOutput: 1000 },
      },
    };

    const fetchFn: FetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(pricingData),
    } as Response);

    const models: ModelPricingTarget[] = [
      { modelId: "gpt-4o", source: "builtin", costPer1kInput: 250, costPer1kOutput: 1000 },
    ];

    const onUpdate = vi.fn();
    const updater = new PricingUpdater({ fetchFn, pricingUrl: "https://example.com/pricing.json" });
    const updated = await updater.updatePricing(models, onUpdate);

    expect(updated).toHaveLength(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
