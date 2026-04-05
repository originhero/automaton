/**
 * Local Conway Client
 *
 * Drop-in replacement for Conway Cloud's ConwayClient that runs entirely
 * on local infrastructure: Docker for sandboxes, SQLite for credits/registry,
 * and direct API calls for inference (OpenAI, Anthropic, Google, Ollama).
 *
 * Implements the full ConwayClient interface from types.ts.
 *
 * OriginHero Phase 1: Decouple Automaton from Conway Cloud.
 */

import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import type Database from "better-sqlite3";
import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import type { ChainType, ChainIdentity } from "../identity/chain.js";
import type { PrivateKeyAccount } from "viem";
import { DockerSandbox, isDockerAvailable } from "./docker-sandbox.js";
import type { DockerSandboxConfig } from "./docker-sandbox.js";
import { LocalCreditsTracker } from "./local-credits.js";
import { LocalRegistry } from "./local-registry.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("local-conway-client");

export interface LocalConwayClientOptions {
  /** The raw better-sqlite3 database instance for local state */
  db: Database.Database;
  /** Sandbox ID for this automaton's own sandbox */
  sandboxId: string;
  /** Docker configuration for sandbox containers */
  docker?: DockerSandboxConfig;
  /** Initial virtual credit balance in cents. Default: 100000 ($1000) */
  initialCreditsCents?: number;
}

/**
 * Create a LocalConwayClient that implements the full ConwayClient interface
 * using local infrastructure instead of Conway Cloud.
 *
 * Components:
 * - DockerSandbox: Container-based sandboxes for code execution
 * - LocalCreditsTracker: SQLite-backed virtual credit balance
 * - LocalRegistry: SQLite-backed automaton/domain/model registry
 */
export function createLocalConwayClient(
  options: LocalConwayClientOptions,
): ConwayClient {
  const { db, sandboxId } = options;

  // ─── Initialize subsystems ──────────────────────────────────────

  // Docker sandbox
  const dockerAvailable = isDockerAvailable();
  const dockerSandbox = new DockerSandbox(options.docker);

  if (dockerAvailable) {
    // Initialize own sandbox asynchronously — first exec call will await this
    const initPromise = dockerSandbox.initOwnSandbox(sandboxId).catch((err) => {
      logger.error(`Failed to initialize Docker sandbox: ${err.message}`);
      logger.warn("Sandbox operations will fall back to local execution.");
    });
    // Store promise for lazy awaiting
    (dockerSandbox as any).__initPromise = initPromise;
  } else {
    logger.warn(
      "Docker is not available. Sandbox exec/writeFile/readFile will use local filesystem. " +
      "Install Docker for full sandbox isolation.",
    );
  }

  // Credits tracker
  const credits = new LocalCreditsTracker(db);
  credits.initialize();

  // Registry
  const registry = new LocalRegistry(db);
  registry.initialize();

  // ─── Helper: ensure Docker is initialized before sandbox ops ────

  async function ensureDocker(): Promise<boolean> {
    if (!dockerAvailable) return false;
    const initPromise = (dockerSandbox as any).__initPromise;
    if (initPromise) {
      await initPromise;
      delete (dockerSandbox as any).__initPromise;
    }
    return true;
  }

  // ─── Local fallbacks for when Docker is not available ───────────

  function execLocal(command: string, timeout?: number): ExecResult {
    try {
      const stdout = execSync(command, {
        timeout: timeout || 30_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.env.HOME || "/root",
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  }

  // ─── ConwayClient Interface Implementation ──────────────────────

  const exec = async (command: string, timeout?: number): Promise<ExecResult> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.exec(command, timeout);
    }
    return execLocal(command, timeout);
  };

  const writeFile = async (path: string, content: string): Promise<void> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.writeFile(path, content);
    }
    // Local fallback
    const resolved = path.startsWith("~")
      ? nodePath.join(process.env.HOME || "/root", path.slice(1))
      : path;
    const dir = nodePath.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
  };

  const readFile = async (path: string): Promise<string> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.readFile(path);
    }
    // Local fallback
    const resolved = path.startsWith("~")
      ? nodePath.join(process.env.HOME || "/root", path.slice(1))
      : path;
    return fs.readFileSync(resolved, "utf-8");
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.exposePort(port);
    }
    return { port, publicUrl: `http://localhost:${port}`, sandboxId: "local" };
  };

  const removePort = async (port: number): Promise<void> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.removePort(port);
    }
    // No-op for local
  };

  const createSandbox = async (opts: CreateSandboxOptions): Promise<SandboxInfo> => {
    const hasDocker = await ensureDocker();
    if (!hasDocker) {
      throw new Error("Docker is required for creating additional sandboxes.");
    }
    return dockerSandbox.createSandbox(opts);
  };

  const deleteSandbox = async (targetId: string): Promise<void> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.deleteSandbox(targetId);
    }
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    const hasDocker = await ensureDocker();
    if (hasDocker) {
      return dockerSandbox.listSandboxes();
    }
    return [];
  };

  // ─── Credits (local SQLite) ─────────────────────────────────────

  const getCreditsBalance = async (): Promise<number> => {
    return credits.getBalance();
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    return credits.getPricingTiers();
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<CreditTransferResult> => {
    return credits.transferCredits(toAddress, amountCents, note);
  };

  // ─── Registration (local SQLite) ────────────────────────────────

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
    chainType?: ChainType;
    chainIdentity?: ChainIdentity;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    return registry.registerAutomaton({
      automatonId: params.automatonId,
      automatonAddress: params.automatonAddress,
      creatorAddress: params.creatorAddress,
      name: params.name,
      bio: params.bio,
      genesisPromptHash: params.genesisPromptHash,
      chainType: params.chainType,
    });
  };

  // ─── Domains (local SQLite) ─────────────────────────────────────

  const searchDomains = async (query: string, tlds?: string): Promise<DomainSearchResult[]> => {
    return registry.searchDomains(query, tlds);
  };

  const registerDomain = async (domain: string, years?: number): Promise<DomainRegistration> => {
    return registry.registerDomain(domain, years);
  };

  const listDnsRecords = async (domain: string): Promise<DnsRecord[]> => {
    return registry.listDnsRecords(domain);
  };

  const addDnsRecord = async (
    domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord> => {
    return registry.addDnsRecord(domain, type, host, value, ttl);
  };

  const deleteDnsRecord = async (domain: string, recordId: string): Promise<void> => {
    return registry.deleteDnsRecord(domain, recordId);
  };

  // ─── Models (local SQLite) ──────────────────────────────────────

  const listModels = async (): Promise<ModelInfo[]> => {
    return registry.listModels();
  };

  // ─── Scoped Client ──────────────────────────────────────────────

  const createScopedClient = (targetSandboxId: string): ConwayClient => {
    // TODO: This creates a new LocalConwayClient which calls initOwnSandbox(),
    // potentially creating a duplicate Docker container for `targetSandboxId`
    // instead of reusing the existing child container managed by this client's
    // DockerSandbox. Consider using DockerSandbox.getScopedExecutor() to share
    // the existing container reference and avoid unnecessary container creation.
    return createLocalConwayClient({
      db,
      sandboxId: targetSandboxId,
      docker: options.docker,
    });
  };

  // ─── Assemble Client ───────────────────────────────────────────

  const client: ConwayClient = {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };

  // Expose the internal credits tracker so callers (e.g. index.ts task mode)
  // can wire inference cost deductions against the SAME instance.
  (client as any).__creditsTracker = credits;

  logger.info(
    `LocalConwayClient initialized (docker=${dockerAvailable}, sandbox=${sandboxId || "local"})`,
  );

  return client;
}

/**
 * Get a LocalCreditsTracker instance for recording inference costs.
 *
 * Prefer using `(client as any).__creditsTracker` when available — that
 * gives you the SAME instance the client uses internally, so balance
 * deductions are reflected immediately.
 *
 * This factory fallback creates a new tracker sharing the same SQLite db,
 * which is safe because all mutations are wrapped in transactions.
 */
export function getCreditsTracker(db: Database.Database): LocalCreditsTracker {
  const tracker = new LocalCreditsTracker(db);
  tracker.initialize();
  return tracker;
}
