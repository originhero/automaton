/**
 * Local Credits Tracker
 *
 * Tracks inference costs and virtual credit balance in SQLite.
 * Replaces Conway Cloud's billing system for local/self-hosted deployments.
 *
 * OriginHero Phase 1: LocalConwayClient
 */

import type Database from "better-sqlite3";
import type { PricingTier, CreditTransferResult } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { ulid } from "ulid";

const logger = createLogger("local-credits");

/** Estimated cost per million tokens by provider/model (in cents) */
const DEFAULT_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  // OpenAI
  "gpt-5.2": { inputPerMillion: 200, outputPerMillion: 800 },
  "gpt-5-mini": { inputPerMillion: 15, outputPerMillion: 60 },
  "gpt-4.1": { inputPerMillion: 200, outputPerMillion: 800 },
  "gpt-4.1-mini": { inputPerMillion: 40, outputPerMillion: 160 },
  "o3": { inputPerMillion: 1000, outputPerMillion: 4000 },
  "o4-mini": { inputPerMillion: 110, outputPerMillion: 440 },
  // Anthropic
  "claude-sonnet-4-6": { inputPerMillion: 300, outputPerMillion: 1500 },
  "claude-opus-4-6": { inputPerMillion: 1500, outputPerMillion: 7500 },
  "claude-haiku-4-5": { inputPerMillion: 80, outputPerMillion: 400 },
  // Google
  "gemini-2.5-pro": { inputPerMillion: 125, outputPerMillion: 1000 },
  "gemini-2.5-flash": { inputPerMillion: 15, outputPerMillion: 60 },
  // Ollama (free)
  "ollama": { inputPerMillion: 0, outputPerMillion: 0 },
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_credits (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL CHECK(type IN ('topup', 'inference', 'transfer', 'sandbox', 'domain')),
  description TEXT,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS local_credit_transfers (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  from_address TEXT,
  to_address TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'completed'
);
`;

export class LocalCreditsTracker {
  private db: Database.Database;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  initialize(): void {
    if (this.initialized) return;
    this.db.exec(SCHEMA_SQL);

    // Initialize with a starting balance if no records exist
    const count = this.db.prepare("SELECT COUNT(*) as c FROM local_credits").get() as any;
    if (count.c === 0) {
      const initialBalance = 1000_00; // $1000 in cents — virtual starting balance
      this.db.prepare(
        "INSERT INTO local_credits (id, type, description, amount_cents, balance_after_cents) VALUES (?, ?, ?, ?, ?)",
      ).run(ulid(), "topup", "Initial virtual balance", initialBalance, initialBalance);
      logger.info(`Initialized local credits with $${(initialBalance / 100).toFixed(2)} virtual balance.`);
    }
    this.initialized = true;
  }

  /**
   * Get current virtual credit balance in cents.
   */
  getBalance(): number {
    const row = this.db.prepare(
      "SELECT balance_after_cents FROM local_credits ORDER BY rowid DESC LIMIT 1",
    ).get() as any;
    return row?.balance_after_cents ?? 0;
  }

  /**
   * Record an inference cost deduction.
   * Wrapped in a transaction to prevent race conditions between balance read and write.
   */
  recordInferenceCost(params: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    provider?: string;
  }): number {
    if (params.promptTokens < 0 || params.completionTokens < 0) {
      throw new Error("Token counts must be non-negative");
    }

    const pricing = this.getPricingForModel(params.model);
    const inputCost = Math.ceil((params.promptTokens / 1_000_000) * pricing.inputPerMillion);
    const outputCost = Math.ceil((params.completionTokens / 1_000_000) * pricing.outputPerMillion);
    const totalCost = inputCost + outputCost;

    if (totalCost === 0) return 0;

    const result = this.db.transaction(() => {
      const currentBalance = this.getBalance();
      const newBalance = currentBalance - totalCost;

      this.db.prepare(
        "INSERT INTO local_credits (id, type, description, amount_cents, balance_after_cents, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        ulid(),
        "inference",
        `${params.model}: ${params.promptTokens}in/${params.completionTokens}out`,
        -totalCost,
        newBalance,
        JSON.stringify({
          model: params.model,
          provider: params.provider,
          promptTokens: params.promptTokens,
          completionTokens: params.completionTokens,
          inputCostCents: inputCost,
          outputCostCents: outputCost,
        }),
      );

      if (newBalance < 500_00) {
        logger.warn(`Low virtual credit balance: $${(newBalance / 100).toFixed(2)}`);
      }

      return totalCost;
    })();

    return result;
  }

  /**
   * Record a sandbox cost (Docker container runtime).
   * Wrapped in a transaction to prevent race conditions between balance read and write.
   */
  recordSandboxCost(sandboxId: string, hourlyRateCents: number = 5): number {
    return this.db.transaction(() => {
      const currentBalance = this.getBalance();
      const newBalance = currentBalance - hourlyRateCents;

      this.db.prepare(
        "INSERT INTO local_credits (id, type, description, amount_cents, balance_after_cents, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        ulid(),
        "sandbox",
        `Sandbox ${sandboxId} hourly charge`,
        -hourlyRateCents,
        newBalance,
        JSON.stringify({ sandboxId }),
      );

      return hourlyRateCents;
    })();
  }

  /**
   * Transfer credits to another address (virtual).
   * Wrapped in a transaction to prevent race conditions between balance read and write.
   */
  transferCredits(toAddress: string, amountCents: number, note?: string): CreditTransferResult {
    if (amountCents <= 0) {
      throw new Error("Transfer amount must be positive");
    }

    return this.db.transaction(() => {
      const currentBalance = this.getBalance();
      if (amountCents > currentBalance) {
        throw new Error(`Insufficient credits. Balance: ${currentBalance}, requested: ${amountCents}`);
      }

      const transferId = ulid();
      const newBalance = currentBalance - amountCents;

      this.db.prepare(
        "INSERT INTO local_credits (id, type, description, amount_cents, balance_after_cents, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        ulid(),
        "transfer",
        `Transfer to ${toAddress}: ${note || ""}`,
        -amountCents,
        newBalance,
        JSON.stringify({ transferId, toAddress, note }),
      );

      this.db.prepare(
        "INSERT INTO local_credit_transfers (id, to_address, amount_cents, note) VALUES (?, ?, ?, ?)",
      ).run(transferId, toAddress, amountCents, note || null);

      return {
        transferId,
        status: "completed",
        toAddress,
        amountCents,
        balanceAfterCents: newBalance,
      };
    })();
  }

  /**
   * Add credits (virtual topup).
   * Wrapped in a transaction to prevent race conditions between balance read and write.
   */
  topup(amountCents: number, description?: string): void {
    this.db.transaction(() => {
      const currentBalance = this.getBalance();
      const newBalance = currentBalance + amountCents;

      this.db.prepare(
        "INSERT INTO local_credits (id, type, description, amount_cents, balance_after_cents) VALUES (?, ?, ?, ?, ?)",
      ).run(ulid(), "topup", description || "Manual topup", amountCents, newBalance);
    })();
  }

  /**
   * Get pricing tiers (local Docker-based).
   */
  getPricingTiers(): PricingTier[] {
    return [
      { name: "micro", vcpu: 0.5, memoryMb: 256, diskGb: 2, monthlyCents: 0 },
      { name: "small", vcpu: 1, memoryMb: 512, diskGb: 5, monthlyCents: 0 },
      { name: "medium", vcpu: 2, memoryMb: 1024, diskGb: 10, monthlyCents: 0 },
      { name: "large", vcpu: 4, memoryMb: 2048, diskGb: 20, monthlyCents: 0 },
    ];
  }

  /**
   * Get recent credit transactions.
   */
  getRecentTransactions(limit: number = 20): Array<{
    id: string;
    timestamp: string;
    type: string;
    description: string;
    amountCents: number;
    balanceAfterCents: number;
  }> {
    return this.db.prepare(
      "SELECT id, timestamp, type, description, amount_cents as amountCents, balance_after_cents as balanceAfterCents FROM local_credits ORDER BY rowid DESC LIMIT ?",
    ).all(limit) as any[];
  }

  private getPricingForModel(model: string): { inputPerMillion: number; outputPerMillion: number } {
    // Exact match
    if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];

    // Prefix match
    for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
      if (model.startsWith(key)) return pricing;
    }

    // Provider heuristics
    if (/^claude/i.test(model)) return DEFAULT_PRICING["claude-sonnet-4-6"];
    if (/^gpt/i.test(model)) return DEFAULT_PRICING["gpt-5-mini"];
    if (/^gemini/i.test(model)) return DEFAULT_PRICING["gemini-2.5-flash"];
    if (/^(llama|mistral|qwen|phi|codestral)/i.test(model)) return DEFAULT_PRICING["ollama"];

    // Default: assume mid-range pricing
    return { inputPerMillion: 100, outputPerMillion: 400 };
  }
}
