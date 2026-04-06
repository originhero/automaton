/**
 * Pricing Updater
 *
 * Fetches model-pricing.json from the OriginHero GitHub repo and merges
 * updated prices into the model registry. Only updates costPer1kInput
 * and costPer1kOutput. Never overwrites custom models (source: "custom").
 *
 * Refresh interval: 24 hours. Silent fail on network errors.
 */

import type { FetchFn } from "../protocols/types.js";

const PRICING_URL =
  "https://raw.githubusercontent.com/originhero/originhero/main/data/model-pricing.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PricingEntry {
  costPer1kInput: number;
  costPer1kOutput: number;
}

export interface PricingData {
  version: number;
  updatedAt: string;
  models: Record<string, PricingEntry>;
}

export interface ModelPricingTarget {
  modelId: string;
  source: string;
  costPer1kInput: number;
  costPer1kOutput: number;
}

export interface PricingUpdateCallback {
  (modelId: string, pricing: PricingEntry): void;
}

export class PricingUpdater {
  private readonly fetchFn: FetchFn;
  private readonly pricingUrl: string;
  private lastFetchedAt: number = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: {
    fetchFn?: FetchFn;
    pricingUrl?: string;
  }) {
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.pricingUrl = options?.pricingUrl ?? PRICING_URL;
  }

  /**
   * Fetch pricing data from the remote URL.
   * Returns null if the fetch fails (network error, bad JSON, etc.).
   */
  async fetchPricing(): Promise<PricingData | null> {
    try {
      const response = await this.fetchFn(this.pricingUrl, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as PricingData;

      if (!data.models || typeof data.models !== "object") {
        return null;
      }

      this.lastFetchedAt = Date.now();
      return data;
    } catch {
      // Silent fail — use existing prices
      return null;
    }
  }

  /**
   * Fetch pricing and merge into the given models list.
   * Skips models with source: "custom".
   * Returns the list of modelIds that were updated.
   */
  async updatePricing(
    models: ModelPricingTarget[],
    onUpdate: PricingUpdateCallback,
  ): Promise<string[]> {
    const data = await this.fetchPricing();
    if (!data) return [];

    const updated: string[] = [];

    for (const model of models) {
      if (model.source === "custom") continue;

      const pricing = data.models[model.modelId];
      if (!pricing) continue;

      if (
        pricing.costPer1kInput !== model.costPer1kInput ||
        pricing.costPer1kOutput !== model.costPer1kOutput
      ) {
        onUpdate(model.modelId, pricing);
        updated.push(model.modelId);
      }
    }

    return updated;
  }

  /**
   * Start periodic pricing refresh.
   */
  startPeriodicRefresh(
    getModels: () => ModelPricingTarget[],
    onUpdate: PricingUpdateCallback,
  ): void {
    this.stopPeriodicRefresh();

    this.refreshTimer = setInterval(async () => {
      const models = getModels();
      await this.updatePricing(models, onUpdate);
    }, REFRESH_INTERVAL_MS);

    // Unref so it doesn't keep the process alive
    if (this.refreshTimer && typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
      (this.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Stop periodic pricing refresh.
   */
  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Whether enough time has passed since the last fetch to warrant a refresh.
   */
  needsRefresh(): boolean {
    return Date.now() - this.lastFetchedAt >= REFRESH_INTERVAL_MS;
  }
}
