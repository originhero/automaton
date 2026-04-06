/**
 * Model Registry
 *
 * DB-backed registry of available models with capabilities and pricing.
 * Seeded from a static baseline, updatable at runtime from Conway API.
 *
 * Also exports ExpandedModelRegistry — an in-memory 3-layer registry for
 * the multi-LLM provider system (builtin catalog + discovered + custom).
 */

import type BetterSqlite3 from "better-sqlite3";
import type { ModelEntry, ModelRegistryRow } from "../types.js";
import { STATIC_MODEL_BASELINE } from "./types.js";
import {
  modelRegistryUpsert,
  modelRegistryGet,
  modelRegistryGetAll,
  modelRegistryGetAvailable,
  modelRegistrySetEnabled,
} from "../state/database.js";

type Database = BetterSqlite3.Database;

const TIER_ORDER: Record<string, number> = {
  dead: 0,
  critical: 1,
  low_compute: 2,
  normal: 3,
  high: 4,
};

export class ModelRegistry {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Upsert the static model baseline into the registry on every startup.
   * New models are added, existing models get updated pricing/capabilities,
   * and models removed from the baseline are disabled.
   */
  initialize(): void {
    const now = new Date().toISOString();
    const baselineIds = new Set(STATIC_MODEL_BASELINE.map((m) => m.modelId));

    // Upsert all baseline models
    for (const model of STATIC_MODEL_BASELINE) {
      const existing = modelRegistryGet(this.db, model.modelId);
      const row: ModelRegistryRow = {
        modelId: model.modelId,
        provider: model.provider,
        displayName: model.displayName,
        tierMinimum: model.tierMinimum,
        costPer1kInput: model.costPer1kInput,
        costPer1kOutput: model.costPer1kOutput,
        maxTokens: model.maxTokens,
        contextWindow: model.contextWindow,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        parameterStyle: model.parameterStyle,
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      modelRegistryUpsert(this.db, row);
    }

    // Disable models no longer in the baseline (e.g., removed Anthropic models).
    // Skip dynamically-discovered providers (e.g. ollama) — they manage their own lifecycle.
    const allModels = modelRegistryGetAll(this.db);
    for (const existing of allModels) {
      if (
        !baselineIds.has(existing.modelId) &&
        existing.enabled &&
        existing.provider !== "ollama" &&
        existing.provider !== "other"
      ) {
        modelRegistrySetEnabled(this.db, existing.modelId, false);
      }
    }
  }

  /**
   * Get a single model by ID.
   */
  get(modelId: string): ModelEntry | undefined {
    const row = modelRegistryGet(this.db, modelId);
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * Get all registered models.
   */
  getAll(): ModelEntry[] {
    return modelRegistryGetAll(this.db).map((r) => this.rowToEntry(r));
  }

  /**
   * Get available (enabled) models, optionally filtering by tier minimum.
   */
  getAvailable(tierMinimum?: string): ModelEntry[] {
    return modelRegistryGetAvailable(this.db, tierMinimum).map((r) => this.rowToEntry(r));
  }

  /**
   * Insert or update a model entry.
   */
  upsert(entry: ModelEntry): void {
    const row: ModelRegistryRow = {
      modelId: entry.modelId,
      provider: entry.provider,
      displayName: entry.displayName,
      tierMinimum: entry.tierMinimum,
      costPer1kInput: entry.costPer1kInput,
      costPer1kOutput: entry.costPer1kOutput,
      maxTokens: entry.maxTokens,
      contextWindow: entry.contextWindow,
      supportsTools: entry.supportsTools,
      supportsVision: entry.supportsVision,
      parameterStyle: entry.parameterStyle,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    modelRegistryUpsert(this.db, row);
  }

  /**
   * Enable or disable a model.
   */
  setEnabled(modelId: string, enabled: boolean): void {
    modelRegistrySetEnabled(this.db, modelId, enabled);
  }

  /**
   * Refresh registry from Conway /v1/models API response.
   */
  refreshFromApi(models: any[]): void {
    const now = new Date().toISOString();
    for (const m of models) {
      const existing = modelRegistryGet(this.db, m.id);
      const row: ModelRegistryRow = {
        modelId: m.id,
        provider: m.provider || m.owned_by || "conway",
        displayName: m.display_name || m.id,
        tierMinimum: existing?.tierMinimum || "normal",
        costPer1kInput: m.pricing?.input_per_1k ?? existing?.costPer1kInput ?? 0,
        costPer1kOutput: m.pricing?.output_per_1k ?? existing?.costPer1kOutput ?? 0,
        maxTokens: m.max_tokens ?? existing?.maxTokens ?? 4096,
        contextWindow: m.context_window ?? existing?.contextWindow ?? 128000,
        supportsTools: m.supports_tools ?? existing?.supportsTools ?? true,
        supportsVision: m.supports_vision ?? existing?.supportsVision ?? false,
        parameterStyle: m.parameter_style ?? existing?.parameterStyle ?? "max_tokens",
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      modelRegistryUpsert(this.db, row);
    }
  }

  /**
   * Get cost per 1k tokens for a model.
   */
  getCostPer1k(modelId: string): { input: number; output: number } {
    const entry = this.get(modelId);
    if (!entry) return { input: 0, output: 0 };
    return { input: entry.costPer1kInput, output: entry.costPer1kOutput };
  }

  private rowToEntry(row: ModelRegistryRow): ModelEntry {
    return {
      modelId: row.modelId,
      provider: row.provider as ModelEntry["provider"],
      displayName: row.displayName,
      tierMinimum: row.tierMinimum as ModelEntry["tierMinimum"],
      costPer1kInput: row.costPer1kInput,
      costPer1kOutput: row.costPer1kOutput,
      maxTokens: row.maxTokens,
      contextWindow: row.contextWindow,
      supportsTools: row.supportsTools,
      supportsVision: row.supportsVision,
      parameterStyle: row.parameterStyle as ModelEntry["parameterStyle"],
      enabled: row.enabled,
      lastSeen: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ─── Expanded Model Registry (Multi-LLM) ────────────────────────────────────

import type { Protocol, DiscoveredModel } from "./protocols/types.js";
import type { BuiltinModelEntry, ModelTier, ModelSource } from "./catalog/builtin-models.js";
import type { PricingEntry } from "./catalog/pricing-updater.js";

export interface ExpandedModelEntry {
  modelId: string;
  provider: string;
  protocol: Protocol;
  baseUrl: string;
  displayName: string;
  tier: ModelTier;
  costPer1kInput: number;
  costPer1kOutput: number;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  source: ModelSource;
  enabled: boolean;
}

export class ExpandedModelRegistry {
  private models: Map<string, ExpandedModelEntry> = new Map();

  constructor(builtins?: BuiltinModelEntry[]) {
    if (builtins) {
      for (const model of builtins) {
        this.models.set(model.modelId, { ...model });
      }
    }
  }

  get(modelId: string): ExpandedModelEntry | undefined {
    return this.models.get(modelId);
  }

  getAll(): ExpandedModelEntry[] {
    return Array.from(this.models.values());
  }

  getEnabled(): ExpandedModelEntry[] {
    return this.getAll().filter((m) => m.enabled);
  }

  getByProtocol(protocol: Protocol): ExpandedModelEntry[] {
    return this.getAll().filter((m) => m.protocol === protocol);
  }

  getByTier(tier: ModelTier): ExpandedModelEntry[] {
    return this.getAll().filter((m) => m.tier === tier);
  }

  setEnabled(modelId: string, enabled: boolean): void {
    const model = this.models.get(modelId);
    if (model) {
      model.enabled = enabled;
    }
  }

  /**
   * Layer 2: Merge discovered models from a provider's listModels() response.
   * If the model already exists in the registry (builtin), keep its metadata.
   * If unknown, add with protocol defaults and source: "discovered".
   */
  mergeDiscovered(
    discovered: DiscoveredModel[],
    protocol: Protocol,
    baseUrl: string,
  ): void {
    for (const d of discovered) {
      if (this.models.has(d.modelId)) {
        // Already in registry (builtin or previously discovered) — skip
        continue;
      }

      this.models.set(d.modelId, {
        modelId: d.modelId,
        provider: d.ownedBy ?? "unknown",
        protocol,
        baseUrl,
        displayName: d.displayName ?? d.modelId,
        tier: "balanced", // default tier for discovered models
        costPer1kInput: 0,
        costPer1kOutput: 0,
        contextWindow: 128000, // conservative default
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
        source: "discovered",
        enabled: true,
      });
    }
  }

  /**
   * Layer 3: Add custom user-defined models.
   * Overwrites any existing entry with the same modelId.
   */
  addCustomModels(models: ExpandedModelEntry[]): void {
    for (const model of models) {
      this.models.set(model.modelId, { ...model, source: "custom" });
    }
  }

  /**
   * Update pricing for a model.
   * Skips models with source: "custom" to respect user customizations.
   */
  updatePricing(modelId: string, pricing: PricingEntry): void {
    const model = this.models.get(modelId);
    if (!model) return;
    if (model.source === "custom") return;

    model.costPer1kInput = pricing.costPer1kInput;
    model.costPer1kOutput = pricing.costPer1kOutput;
  }

  /**
   * Get all models as pricing target objects for the PricingUpdater.
   */
  getPricingTargets(): Array<{
    modelId: string;
    source: string;
    costPer1kInput: number;
    costPer1kOutput: number;
  }> {
    return this.getAll().map((m) => ({
      modelId: m.modelId,
      source: m.source,
      costPer1kInput: m.costPer1kInput,
      costPer1kOutput: m.costPer1kOutput,
    }));
  }
}
