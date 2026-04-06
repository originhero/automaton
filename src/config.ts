/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig, BusinessConfig } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";
import { PROVIDER_DEFAULT_URLS, PROVIDER_ENV_VARS } from "./inference/catalog/builtin-models.js";
import type { Protocol } from "./inference/protocols/types.js";
import type { ModelTier } from "./inference/catalog/builtin-models.js";

// ─── SSRF Protection ────────────────────────────────────────────────────────

/**
 * Validate that a base URL does not point to internal/metadata IP addresses.
 * Allows localhost (127.0.0.1) only for Ollama.
 * Blocks: 169.254.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x (non-Ollama).
 */
export function validateBaseUrl(
  url: string,
  providerName: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname;

  // Resolve hostname to check against blocked ranges
  // For IP-literal hostnames, check directly
  const ipv4Match = hostname.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );

  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);

    // AWS/cloud metadata endpoint
    if (a === 169 && b === 254) return false;

    // Private class A
    if (a === 10) return false;

    // Private class B
    if (a === 172 && b >= 16 && b <= 31) return false;

    // Private class C
    if (a === 192 && b === 168) return false;

    // Loopback — allow only for Ollama
    if (a === 127) {
      return providerName === "ollama";
    }
  }

  // Block "localhost" hostname for non-Ollama providers
  if (
    (hostname === "localhost" || hostname === "::1") &&
    providerName !== "ollama"
  ) {
    return false;
  }

  return true;
}

// ─── Provider Config Types ───────────────────────────────────────────────────

export interface ResolvedProviderConfig {
  apiKey?: string;
  baseUrl: string;
}

export interface CustomProviderEntry {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  tier: ModelTier;
}

export interface ResolvedProviderConfigs {
  openai?: ResolvedProviderConfig;
  anthropic?: ResolvedProviderConfig;
  deepseek?: ResolvedProviderConfig;
  xai?: ResolvedProviderConfig;
  google?: ResolvedProviderConfig;
  groq?: ResolvedProviderConfig;
  together?: ResolvedProviderConfig;
  mistral?: ResolvedProviderConfig;
  openrouter?: ResolvedProviderConfig;
  ollama?: ResolvedProviderConfig;
  custom?: CustomProviderEntry[];
}

/**
 * Resolve provider configurations with 3-level priority:
 *   1. config.providers section (highest)
 *   2. config legacy keys (openaiApiKey, anthropicApiKey, etc.)
 *   3. environment variables (OPENAI_API_KEY, etc.) (lowest)
 */
export function resolveProviderConfigs(config: Record<string, unknown>): ResolvedProviderConfigs {
  const result: ResolvedProviderConfigs = {};
  const providers = (config.providers ?? {}) as Record<string, unknown>;

  // Standard providers (not custom)
  const standardProviders = [
    "openai", "anthropic", "deepseek", "xai", "google",
    "groq", "together", "mistral", "openrouter", "ollama",
  ] as const;

  // Legacy key mapping: old config key -> provider name
  const legacyKeyMap: Record<string, string> = {
    openaiApiKey: "openai",
    anthropicApiKey: "anthropic",
    googleApiKey: "google",
  };

  // Legacy baseUrl mapping
  const legacyBaseUrlMap: Record<string, string> = {
    ollamaBaseUrl: "ollama",
  };

  for (const providerName of standardProviders) {
    let apiKey: string | undefined;
    let baseUrl: string = PROVIDER_DEFAULT_URLS[providerName] ?? "";

    // Priority 1: config.providers section
    const providerSection = providers[providerName] as Record<string, unknown> | undefined;
    if (providerSection && typeof providerSection === "object") {
      if (typeof providerSection.apiKey === "string") {
        apiKey = providerSection.apiKey;
      }
      if (typeof providerSection.baseUrl === "string") {
        baseUrl = providerSection.baseUrl;
      }
    }

    // Priority 2: legacy config keys (only if not set by providers section)
    if (!apiKey) {
      for (const [legacyKey, targetProvider] of Object.entries(legacyKeyMap)) {
        if (targetProvider === providerName && typeof config[legacyKey] === "string") {
          apiKey = config[legacyKey] as string;
        }
      }
    }

    // Priority 2b: legacy baseUrl keys (only if not set by providers section)
    for (const [legacyKey, targetProvider] of Object.entries(legacyBaseUrlMap)) {
      if (
        targetProvider === providerName &&
        typeof config[legacyKey] === "string" &&
        !providerSection?.baseUrl
      ) {
        baseUrl = config[legacyKey] as string;
      }
    }

    // Priority 3: environment variables (lowest)
    if (!apiKey) {
      const envVar = PROVIDER_ENV_VARS[providerName];
      if (envVar) {
        const envValue = process.env[envVar];
        if (typeof envValue === "string" && envValue.length > 0) {
          apiKey = envValue;
        }
      }
    }

    // Bug H fix: validate baseUrl against SSRF targets
    if (baseUrl && !validateBaseUrl(baseUrl, providerName)) {
      logger.warn(
        `Blocked provider "${providerName}" baseUrl "${baseUrl}" — points to a private/metadata IP`,
      );
      continue;
    }

    // Only add to result if we have at least an API key or it's Ollama (no key needed)
    if (apiKey || providerName === "ollama") {
      (result as Record<string, unknown>)[providerName] = { apiKey, baseUrl };
    }
  }

  // Custom providers
  if (Array.isArray(providers.custom)) {
    result.custom = (providers.custom as unknown[])
      .filter((entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).name === "string",
      )
      .map((entry) => ({
        name: entry.name as string,
        protocol: (entry.protocol as Protocol) ?? "openai-compatible",
        baseUrl: (entry.baseUrl as string) ?? "",
        apiKey: (entry.apiKey as string) ?? "",
        tier: (entry.tier as ModelTier) ?? "balanced",
      }))
      // Bug H fix: filter out custom providers with SSRF-unsafe baseUrls
      .filter((entry) => {
        if (entry.baseUrl && !validateBaseUrl(entry.baseUrl, entry.name)) {
          logger.warn(
            `Blocked custom provider "${entry.name}" baseUrl "${entry.baseUrl}" — points to a private/metadata IP`,
          );
          return false;
        }
        return true;
      });
  }

  return result;
}

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.conwayApiKey || loadApiKeyFromConfig();

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    // Normalize business config if present
    const business: BusinessConfig | undefined = raw.business
      ? normalizeBusinessConfig(raw.business)
      : undefined;

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
      business,
    } as AutomatonConfig;
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
    business: config.business ?? undefined,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Normalize and validate the business config from raw JSON.
 */
function normalizeBusinessConfig(raw: any): BusinessConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (!raw.name || !raw.repo?.url) {
    logger.warn("Business config requires at least 'name' and 'repo.url'. Ignoring.");
    return undefined;
  }

  return {
    name: raw.name,
    description: raw.description,
    repo: {
      url: raw.repo.url,
      branch: raw.repo.branch || "main",
      accessTokenEnvVar: raw.repo.accessTokenEnvVar,
      localPath: raw.repo.localPath,
    },
    domains: Array.isArray(raw.domains)
      ? raw.domains.map((d: any) => ({
          fqdn: d.fqdn,
          dnsProvider: d.dnsProvider,
          sslManaged: d.sslManaged ?? true,
          role: d.role || "primary",
        }))
      : [],
    servers: Array.isArray(raw.servers)
      ? raw.servers.map((s: any) => ({
          id: s.id || s.name || "default",
          name: s.name || s.id,
          provider: s.provider || "unknown",
          type: s.type || "vps",
          host: s.host,
          sshPort: s.sshPort || 22,
          sshUser: s.sshUser || "root",
          sshKeyEnvVar: s.sshKeyEnvVar,
          region: s.region,
          role: s.role || "production",
          deployMethod: s.deployMethod,
          deployPath: s.deployPath,
        }))
      : [],
    services: Array.isArray(raw.services)
      ? raw.services.map((svc: any) => ({
          name: svc.name,
          type: svc.type || "other",
          url: svc.url,
          apiKeyEnvVar: svc.apiKeyEnvVar,
          notes: svc.notes,
        }))
      : undefined,
    stack: raw.stack || undefined,
  };
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    googleApiKey: params.googleApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
  };
}
