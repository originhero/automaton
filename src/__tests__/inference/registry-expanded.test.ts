import { describe, it, expect, beforeEach } from "vitest";
import { ExpandedModelRegistry, type ExpandedModelEntry } from "../../inference/registry.js";
import type { BuiltinModelEntry } from "../../inference/catalog/builtin-models.js";
import type { DiscoveredModel } from "../../inference/protocols/types.js";

// Minimal builtin models for testing
const TEST_BUILTINS: BuiltinModelEntry[] = [
  {
    modelId: "gpt-4o",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    displayName: "GPT-4o",
    tier: "frontier",
    costPer1kInput: 250,
    costPer1kOutput: 1000,
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "gemini-2.5-flash",
    provider: "google",
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    displayName: "Gemini 2.5 Flash",
    tier: "economy",
    costPer1kInput: 15,
    costPer1kOutput: 60,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "deepseek-r1",
    provider: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    displayName: "DeepSeek R1",
    tier: "balanced",
    costPer1kInput: 55,
    costPer1kOutput: 219,
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
];

describe("ExpandedModelRegistry", () => {
  let registry: ExpandedModelRegistry;

  beforeEach(() => {
    registry = new ExpandedModelRegistry(TEST_BUILTINS);
  });

  describe("Layer 1: Builtin Catalog", () => {
    it("initializes with builtin models", () => {
      const all = registry.getAll();
      expect(all).toHaveLength(3);
    });

    it("can look up a builtin model by ID", () => {
      const model = registry.get("gpt-4o");
      expect(model).toBeDefined();
      expect(model!.provider).toBe("openai");
      expect(model!.protocol).toBe("openai-compatible");
      expect(model!.source).toBe("builtin");
    });
  });

  describe("Layer 2: Discovered Models", () => {
    it("merges discovered models into the registry", () => {
      const discovered: DiscoveredModel[] = [
        { modelId: "gpt-4o", displayName: "GPT-4o", ownedBy: "openai" },
        { modelId: "gpt-4-turbo", displayName: "GPT-4 Turbo", ownedBy: "openai" },
      ];

      registry.mergeDiscovered(discovered, "openai-compatible", "https://api.openai.com/v1");

      // Existing model should keep its builtin data
      const existing = registry.get("gpt-4o");
      expect(existing!.source).toBe("builtin");
      expect(existing!.costPer1kInput).toBe(250);

      // New model should be added with source: "discovered"
      const newModel = registry.get("gpt-4-turbo");
      expect(newModel).toBeDefined();
      expect(newModel!.source).toBe("discovered");
      expect(newModel!.protocol).toBe("openai-compatible");
    });
  });

  describe("Layer 3: Custom Models", () => {
    it("adds custom models to the registry", () => {
      const custom: ExpandedModelEntry = {
        modelId: "my-corp-llm",
        provider: "custom",
        protocol: "openai-compatible",
        baseUrl: "https://llm.internal.corp/v1",
        displayName: "My Corp LLM",
        tier: "balanced",
        costPer1kInput: 0,
        costPer1kOutput: 0,
        contextWindow: 32000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
        source: "custom",
        enabled: true,
      };

      registry.addCustomModels([custom]);
      const model = registry.get("my-corp-llm");
      expect(model).toBeDefined();
      expect(model!.source).toBe("custom");

      // Total should now be 4
      expect(registry.getAll()).toHaveLength(4);
    });

    it("custom models are not overwritten by pricing updates", () => {
      const custom: ExpandedModelEntry = {
        modelId: "my-corp-llm",
        provider: "custom",
        protocol: "openai-compatible",
        baseUrl: "https://llm.internal.corp/v1",
        displayName: "My Corp LLM",
        tier: "balanced",
        costPer1kInput: 100,
        costPer1kOutput: 200,
        contextWindow: 32000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
        source: "custom",
        enabled: true,
      };

      registry.addCustomModels([custom]);

      // Simulate pricing update
      registry.updatePricing("my-corp-llm", { costPer1kInput: 999, costPer1kOutput: 999 });

      const model = registry.get("my-corp-llm");
      // Should NOT be updated because source is "custom"
      expect(model!.costPer1kInput).toBe(100);
      expect(model!.costPer1kOutput).toBe(200);
    });
  });

  describe("Filtering", () => {
    it("getByProtocol returns models matching a protocol", () => {
      const openai = registry.getByProtocol("openai-compatible");
      expect(openai).toHaveLength(2); // gpt-4o and deepseek-r1
    });

    it("getByTier returns models matching a tier", () => {
      const frontier = registry.getByTier("frontier");
      expect(frontier).toHaveLength(1); // gpt-4o
      expect(frontier[0].modelId).toBe("gpt-4o");

      const economy = registry.getByTier("economy");
      expect(economy).toHaveLength(1);
      expect(economy[0].modelId).toBe("gemini-2.5-flash");
    });

    it("getEnabled returns only enabled models", () => {
      registry.setEnabled("gpt-4o", false);
      const enabled = registry.getEnabled();
      expect(enabled).toHaveLength(2); // gemini + deepseek
    });
  });
});
