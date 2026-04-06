/**
 * Builtin Model Catalog
 *
 * Pre-loaded ModelEntry definitions for all major providers.
 * These form Layer 1 of the 3-layer model registry.
 *
 * Pricing is in hundredths of cents per 1k tokens.
 * Example: $2.50/M input = 250 cents/M = 0.25 cents/1k = 25 hundredths.
 */

import type { Protocol } from "../protocols/types.js";

export type ModelTier = "frontier" | "balanced" | "economy" | "local";

export type ModelSource = "builtin" | "discovered" | "custom";

export interface BuiltinModelEntry {
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

export const BUILTIN_MODELS: BuiltinModelEntry[] = [
  // ─── OpenAI ─────────────────────────────────────────────────────
  {
    modelId: "gpt-4o",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    displayName: "GPT-4o",
    tier: "frontier",
    costPer1kInput: 250,    // $2.50/M
    costPer1kOutput: 1000,  // $10.00/M
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "gpt-4o-mini",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    displayName: "GPT-4o Mini",
    tier: "economy",
    costPer1kInput: 15,     // $0.15/M
    costPer1kOutput: 60,    // $0.60/M
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "o3-mini",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    displayName: "o3-mini",
    tier: "balanced",
    costPer1kInput: 110,    // $1.10/M
    costPer1kOutput: 440,   // $4.40/M
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "gpt-5.2",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    displayName: "GPT-5.2",
    tier: "frontier",
    costPer1kInput: 18,     // ~$1.75/M
    costPer1kOutput: 140,   // ~$14.00/M
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "gpt-5-mini",
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    displayName: "GPT-5 Mini",
    tier: "economy",
    costPer1kInput: 8,      // ~$0.80/M
    costPer1kOutput: 32,    // ~$3.20/M
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── Anthropic ──────────────────────────────────────────────────
  {
    modelId: "claude-sonnet-4-20250514",
    provider: "anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    displayName: "Claude Sonnet 4",
    tier: "frontier",
    costPer1kInput: 300,    // $3.00/M
    costPer1kOutput: 1500,  // $15.00/M
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "claude-haiku-4-20250514",
    provider: "anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    displayName: "Claude Haiku 4",
    tier: "economy",
    costPer1kInput: 80,     // $0.80/M
    costPer1kOutput: 400,   // $4.00/M
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── Google ─────────────────────────────────────────────────────
  {
    modelId: "gemini-2.5-pro",
    provider: "google",
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    displayName: "Gemini 2.5 Pro",
    tier: "frontier",
    costPer1kInput: 125,    // $1.25/M
    costPer1kOutput: 1000,  // $10.00/M
    contextWindow: 1048576,
    maxOutputTokens: 65536,
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
    costPer1kInput: 15,     // $0.15/M
    costPer1kOutput: 60,    // $0.60/M
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── DeepSeek ───────────────────────────────────────────────────
  {
    modelId: "deepseek-r1",
    provider: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    displayName: "DeepSeek R1",
    tier: "balanced",
    costPer1kInput: 55,     // $0.55/M (cache miss)
    costPer1kOutput: 219,   // $2.19/M
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "deepseek-v3",
    provider: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    displayName: "DeepSeek V3",
    tier: "economy",
    costPer1kInput: 14,     // $0.14/M (cache miss)
    costPer1kOutput: 28,    // $0.28/M
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── xAI (Grok) ────────────────────────────────────────────────
  {
    modelId: "grok-3",
    provider: "xai",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    displayName: "Grok 3",
    tier: "frontier",
    costPer1kInput: 300,    // $3.00/M
    costPer1kOutput: 500,   // $5.00/M
    contextWindow: 131072,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "grok-3-mini",
    provider: "xai",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    displayName: "Grok 3 Mini",
    tier: "economy",
    costPer1kInput: 30,     // $0.30/M
    costPer1kOutput: 50,    // $0.50/M
    contextWindow: 131072,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── Groq ───────────────────────────────────────────────────────
  {
    modelId: "llama-3.3-70b-versatile",
    provider: "groq",
    protocol: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    displayName: "Llama 3.3 70B (Groq)",
    tier: "balanced",
    costPer1kInput: 20,     // $0.20/M
    costPer1kOutput: 20,    // $0.20/M
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "llama-3.1-8b-instant",
    provider: "groq",
    protocol: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    displayName: "Llama 3.1 8B (Groq)",
    tier: "economy",
    costPer1kInput: 5,      // $0.05/M
    costPer1kOutput: 8,     // $0.08/M
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── Together AI ────────────────────────────────────────────────
  {
    modelId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    provider: "together",
    protocol: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    displayName: "Llama 3.3 70B (Together)",
    tier: "balanced",
    costPer1kInput: 25,     // $0.25/M
    costPer1kOutput: 50,    // $0.50/M
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── Mistral ────────────────────────────────────────────────────
  {
    modelId: "mistral-large-latest",
    provider: "mistral",
    protocol: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    displayName: "Mistral Large",
    tier: "frontier",
    costPer1kInput: 200,    // $2.00/M
    costPer1kOutput: 600,   // $6.00/M
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
  {
    modelId: "mistral-small-latest",
    provider: "mistral",
    protocol: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    displayName: "Mistral Small",
    tier: "economy",
    costPer1kInput: 20,     // $0.20/M
    costPer1kOutput: 60,    // $0.60/M
    contextWindow: 32000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── OpenRouter ─────────────────────────────────────────────────
  {
    modelId: "openrouter/auto",
    provider: "openrouter",
    protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    displayName: "OpenRouter Auto",
    tier: "balanced",
    costPer1kInput: 0,      // Variable — depends on selected model
    costPer1kOutput: 0,     // Variable
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },

  // ─── Ollama (local) ─────────────────────────────────────────────
  {
    modelId: "ollama-local",
    provider: "ollama",
    protocol: "ollama",
    baseUrl: "http://localhost:11434",
    displayName: "Ollama (Local)",
    tier: "local",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
    source: "builtin",
    enabled: true,
  },
];

/**
 * Default base URLs for each provider.
 * Users only need to provide an API key; the base URL is filled in automatically.
 */
export const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434",
};

/**
 * Environment variable names for provider API keys (lowest-priority fallback).
 */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
