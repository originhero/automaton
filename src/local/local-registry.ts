/**
 * Local Automaton Registry
 *
 * Persists automaton registrations and domain operations in SQLite.
 * Replaces Conway Cloud's registry and domain services for local deployments.
 *
 * OriginHero Phase 1: LocalConwayClient
 */

import type Database from "better-sqlite3";
import type {
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import { createLogger } from "../observability/logger.js";
import { ulid } from "ulid";

const logger = createLogger("local-registry");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_automatons (
  automaton_id TEXT PRIMARY KEY,
  automaton_address TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT,
  genesis_prompt_hash TEXT,
  chain_type TEXT DEFAULT 'evm',
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS local_domains (
  domain TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  transaction_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_dns_records (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  value TEXT NOT NULL,
  ttl INTEGER DEFAULT 3600,
  FOREIGN KEY (domain) REFERENCES local_domains(domain)
);

CREATE TABLE IF NOT EXISTS local_models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  input_per_million REAL DEFAULT 0,
  output_per_million REAL DEFAULT 0,
  available INTEGER DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class LocalRegistry {
  private db: Database.Database;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  initialize(): void {
    if (this.initialized) return;
    this.db.exec(SCHEMA_SQL);

    // Seed default model list if empty
    const count = this.db.prepare("SELECT COUNT(*) as c FROM local_models").get() as any;
    if (count.c === 0) {
      this.seedDefaultModels();
    }
    this.initialized = true;
  }

  // ─── Automaton Registration ─────────────────────────────────────

  registerAutomaton(params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: string;
    chainType?: string;
  }): { automaton: Record<string, unknown> } {
    // Check for duplicate
    const existing = this.db.prepare(
      "SELECT automaton_id FROM local_automatons WHERE automaton_id = ?",
    ).get(params.automatonId) as any;

    if (existing) {
      const err: any = new Error(`Automaton ${params.automatonId} already registered`);
      err.status = 409;
      throw err;
    }

    this.db.prepare(`
      INSERT INTO local_automatons (automaton_id, automaton_address, creator_address, name, bio, genesis_prompt_hash, chain_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.automatonId,
      params.automatonAddress,
      params.creatorAddress,
      params.name,
      params.bio || "",
      params.genesisPromptHash || null,
      params.chainType || "evm",
    );

    logger.info(`Registered automaton: ${params.name} (${params.automatonId})`);

    return {
      automaton: {
        automaton_id: params.automatonId,
        automaton_address: params.automatonAddress,
        creator_address: params.creatorAddress,
        name: params.name,
        status: "registered",
      },
    };
  }

  getAutomaton(automatonId: string): Record<string, unknown> | null {
    return this.db.prepare(
      "SELECT * FROM local_automatons WHERE automaton_id = ?",
    ).get(automatonId) as any;
  }

  // ─── Domain Operations ──────────────────────────────────────────

  searchDomains(query: string, _tlds?: string): DomainSearchResult[] {
    // Local registry: check if domain is taken locally
    const tlds = _tlds?.split(",").map((t) => t.trim()) || ["local", "agent", "auto"];

    return tlds.map((tld) => {
      const domain = `${query}.${tld}`;
      const existing = this.db.prepare(
        "SELECT domain FROM local_domains WHERE domain = ?",
      ).get(domain);
      return {
        domain,
        available: !existing,
        registrationPrice: 0, // Free for local
        renewalPrice: 0,
        currency: "USD",
      };
    });
  }

  registerDomain(domain: string, years: number = 1): DomainRegistration {
    const existing = this.db.prepare(
      "SELECT domain FROM local_domains WHERE domain = ?",
    ).get(domain);
    if (existing) {
      throw new Error(`Domain ${domain} already registered`);
    }

    const transactionId = ulid();
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + years);

    this.db.prepare(`
      INSERT INTO local_domains (domain, owner_address, expires_at, transaction_id)
      VALUES (?, ?, ?, ?)
    `).run(domain, "local", expiresAt.toISOString(), transactionId);

    logger.info(`Registered local domain: ${domain}`);

    return {
      domain,
      status: "registered",
      expiresAt: expiresAt.toISOString(),
      transactionId,
    };
  }

  listDnsRecords(domain: string): DnsRecord[] {
    return this.db.prepare(
      "SELECT id, type, host, value, ttl FROM local_dns_records WHERE domain = ?",
    ).all(domain) as DnsRecord[];
  }

  addDnsRecord(domain: string, type: string, host: string, value: string, ttl?: number): DnsRecord {
    const id = ulid();
    this.db.prepare(`
      INSERT INTO local_dns_records (id, domain, type, host, value, ttl)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, domain, type, host, value, ttl || 3600);

    return { id, type, host, value, ttl: ttl || 3600 };
  }

  deleteDnsRecord(domain: string, recordId: string): void {
    this.db.prepare(
      "DELETE FROM local_dns_records WHERE id = ? AND domain = ?",
    ).run(recordId, domain);
  }

  // ─── Model Discovery ────────────────────────────────────────────

  listModels(): ModelInfo[] {
    const rows = this.db.prepare(
      "SELECT id, provider, input_per_million, output_per_million FROM local_models WHERE available = 1",
    ).all() as any[];

    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      pricing: {
        inputPerMillion: r.input_per_million,
        outputPerMillion: r.output_per_million,
      },
    }));
  }

  addModel(id: string, provider: string, inputPerMillion: number, outputPerMillion: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO local_models (id, provider, input_per_million, output_per_million)
      VALUES (?, ?, ?, ?)
    `).run(id, provider, inputPerMillion, outputPerMillion);
  }

  private seedDefaultModels(): void {
    const models = [
      // OpenAI
      { id: "gpt-5.2", provider: "openai", input: 200, output: 800 },
      { id: "gpt-5-mini", provider: "openai", input: 15, output: 60 },
      { id: "gpt-4.1", provider: "openai", input: 200, output: 800 },
      { id: "gpt-4.1-mini", provider: "openai", input: 40, output: 160 },
      { id: "o3", provider: "openai", input: 1000, output: 4000 },
      { id: "o4-mini", provider: "openai", input: 110, output: 440 },
      // Anthropic
      { id: "claude-sonnet-4-6", provider: "anthropic", input: 300, output: 1500 },
      { id: "claude-opus-4-6", provider: "anthropic", input: 1500, output: 7500 },
      { id: "claude-haiku-4-5", provider: "anthropic", input: 80, output: 400 },
      // Google
      { id: "gemini-2.5-pro", provider: "google", input: 125, output: 1000 },
      { id: "gemini-2.5-flash", provider: "google", input: 15, output: 60 },
    ];

    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO local_models (id, provider, input_per_million, output_per_million) VALUES (?, ?, ?, ?)",
    );
    for (const m of models) {
      stmt.run(m.id, m.provider, m.input, m.output);
    }
    logger.info(`Seeded ${models.length} default models in local registry.`);
  }
}
