/**
 * Protocol Layer Types
 *
 * Shared interfaces for the 4 inference protocol adapters.
 * These types are internal to the protocol layer — the rest of
 * the codebase interacts via InferenceRouter and ModelRegistry.
 */

// ─── Protocol Identifier ────────────────────────────────────────

export type Protocol = "openai-compatible" | "anthropic" | "google" | "ollama";

// ─── Messages ───────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Chat Options & Results ─────────────────────────────────────

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  toolCalls?: ToolCall[];
}

export interface ChatChunk {
  delta: string;
  finishReason?: string;
  toolCalls?: ToolCall[];
}

// ─── Discovery ──────────────────────────────────────────────────

export interface DiscoveredModel {
  modelId: string;
  displayName?: string;
  ownedBy?: string;
}

// ─── Protocol Interface ─────────────────────────────────────────

export interface InferenceProtocol {
  readonly protocol: Protocol;

  chat(messages: Message[], options: ChatOptions): Promise<ChatResult>;

  chatStream?(messages: Message[], options: ChatOptions): AsyncIterable<ChatChunk>;

  listModels?(): Promise<DiscoveredModel[]>;
}

// ─── Shared Fetch Type ──────────────────────────────────────────

/**
 * Injectable fetch function type. All protocol adapters accept this
 * as a constructor parameter so tests can inject a mock without
 * touching globalThis.fetch.
 */
export type FetchFn = typeof globalThis.fetch;
