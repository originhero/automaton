/**
 * Inference & Model Strategy — Internal Types
 *
 * Re-exports shared types from types.ts and defines internal constants
 * for the inference routing subsystem.
 */

export type {
  SurvivalTier,
  ModelProvider,
  InferenceTaskType,
  ModelEntry,
  ModelPreference,
  RoutingMatrix,
  InferenceRequest,
  InferenceResult,
  InferenceCostRow,
  ModelRegistryRow,
  ModelStrategyConfig,
  ChatMessage,
} from "../types.js";

import type {
  RoutingMatrix,
  ModelEntry,
  ModelStrategyConfig,
} from "../types.js";

// === Protocol & Catalog Type Re-exports ===

export type { Protocol } from "./protocols/types.js";
export type { ModelTier, ModelSource, BuiltinModelEntry } from "./catalog/builtin-models.js";
export { BUILTIN_MODELS, PROVIDER_DEFAULT_URLS, PROVIDER_ENV_VARS } from "./catalog/builtin-models.js";

// === Default Retry Policy ===

export const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
} as const;

// === Per-Task Timeout Overrides (ms) ===

export const TASK_TIMEOUTS: Record<string, number> = {
  heartbeat_triage: 15_000,
  safety_check: 30_000,
  summarization: 60_000,
  agent_turn: 120_000,
  planning: 120_000,
};

// === Static Model Baseline ===
// Known models with realistic pricing (hundredths of cents per 1k tokens)

export const STATIC_MODEL_BASELINE: Omit<ModelEntry, "lastSeen" | "createdAt" | "updatedAt">[] = [
  {
    modelId: "gpt-5.2",
    provider: "openai",
    displayName: "GPT-5.2",
    tierMinimum: "normal",
    costPer1kInput: 18,    // $1.75/M = 175 cents/M = 0.175 cents/1k = 17.5 hundredths ≈ 18
    costPer1kOutput: 140,  // $14.00/M = 1400 cents/M = 1.4 cents/1k = 140 hundredths
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1",
    provider: "openai",
    displayName: "GPT-4.1",
    tierMinimum: "normal",
    costPer1kInput: 20,    // $2.00/M
    costPer1kOutput: 80,   // $8.00/M
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1-mini",
    provider: "openai",
    displayName: "GPT-4.1 Mini",
    tierMinimum: "low_compute",
    costPer1kInput: 4,     // $0.40/M
    costPer1kOutput: 16,   // $1.60/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1-nano",
    provider: "openai",
    displayName: "GPT-4.1 Nano",
    tierMinimum: "critical",
    costPer1kInput: 1,     // $0.10/M
    costPer1kOutput: 4,    // $0.40/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 Mini",
    tierMinimum: "low_compute",
    costPer1kInput: 8,     // $0.80/M
    costPer1kOutput: 32,   // $3.20/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-5.3",
    provider: "openai",
    displayName: "GPT-5.3",
    tierMinimum: "normal",
    costPer1kInput: 20,    // $2.00/M
    costPer1kOutput: 80,   // $8.00/M
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  // ─── Google Gemini ──────────────────────────────────────────────
  {
    modelId: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    tierMinimum: "normal",
    costPer1kInput: 13,    // $1.25/M
    costPer1kOutput: 100,  // $10.00/M
    maxTokens: 65536,
    contextWindow: 1048576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_tokens",
    enabled: true,
  },
  {
    modelId: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    tierMinimum: "low_compute",
    costPer1kInput: 2,     // $0.15/M
    costPer1kOutput: 6,    // $0.60/M
    maxTokens: 65536,
    contextWindow: 1048576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_tokens",
    enabled: true,
  },
];

// === Default Routing Matrix ===
// Maps (tier, taskType) -> ModelPreference with candidate models

export const DEFAULT_ROUTING_MATRIX: RoutingMatrix = {
  high: {
    agent_turn: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5.3", "gemini-2.5-pro"], maxTokens: 8192, ceilingCents: -1 },
    heartbeat_triage: { candidates: ["gemini-2.5-flash", "gpt-5-mini"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5.3", "gemini-2.5-pro"], maxTokens: 4096, ceilingCents: 20 },
    summarization: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5-mini"], maxTokens: 4096, ceilingCents: 15 },
    planning: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5.3", "gemini-2.5-pro"], maxTokens: 8192, ceilingCents: -1 },
  },
  normal: {
    agent_turn: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5-mini", "gemini-2.5-pro"], maxTokens: 4096, ceilingCents: -1 },
    heartbeat_triage: { candidates: ["gemini-2.5-flash", "gpt-5-mini"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5-mini", "gemini-2.5-pro"], maxTokens: 4096, ceilingCents: 10 },
    summarization: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5-mini"], maxTokens: 4096, ceilingCents: 10 },
    planning: { candidates: ["gemini-2.5-flash", "gpt-5.2", "gpt-5-mini", "gemini-2.5-pro"], maxTokens: 4096, ceilingCents: -1 },
  },
  low_compute: {
    agent_turn: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 4096, ceilingCents: 10 },
    heartbeat_triage: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 1024, ceilingCents: 2 },
    safety_check: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 2048, ceilingCents: 5 },
    summarization: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 2048, ceilingCents: 5 },
    planning: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 2048, ceilingCents: 5 },
  },
  critical: {
    agent_turn: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 2048, ceilingCents: 3 },
    heartbeat_triage: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 512, ceilingCents: 1 },
    safety_check: { candidates: ["gpt-5-mini", "gemini-2.5-flash"], maxTokens: 1024, ceilingCents: 2 },
    summarization: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    planning: { candidates: [], maxTokens: 0, ceilingCents: 0 },
  },
  dead: {
    agent_turn: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    heartbeat_triage: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    safety_check: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    summarization: { candidates: [], maxTokens: 0, ceilingCents: 0 },
    planning: { candidates: [], maxTokens: 0, ceilingCents: 0 },
  },
};

// === Default Model Strategy Config ===

export const DEFAULT_MODEL_STRATEGY_CONFIG: ModelStrategyConfig = {
  inferenceModel: "gemini-2.5-flash",
  lowComputeModel: "gemini-2.5-flash",
  criticalModel: "gemini-2.5-flash",
  maxTokensPerTurn: 4096,
  hourlyBudgetCents: 10,       // $0.10/hour default — protects against runaway loops
  sessionBudgetCents: 100,     // $1.00/session default
  perCallCeilingCents: 0,
  enableModelFallback: true,
  anthropicApiVersion: "2023-06-01",
};
