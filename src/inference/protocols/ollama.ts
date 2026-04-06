/**
 * Ollama Protocol Adapter
 *
 * Extends OpenAI-compatible protocol for local Ollama instances.
 * Ollama exposes an OpenAI-compatible API at /v1, plus its own
 * discovery endpoint at /api/tags.
 *
 * All Ollama models have zero cost (local inference).
 */

import type {
  InferenceProtocol,
  Protocol,
  Message,
  ChatOptions,
  ChatResult,
  ChatChunk,
  DiscoveredModel,
  FetchFn,
} from "./types.js";
import { OpenAICompatibleProtocol } from "./openai-compatible.js";

export interface OllamaConfig {
  baseUrl?: string;
  fetchFn?: FetchFn;
}

export class OllamaProtocol implements InferenceProtocol {
  readonly protocol: Protocol = "ollama";

  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly openaiAdapter: OpenAICompatibleProtocol;

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);

    // Ollama exposes OpenAI-compatible endpoints at /v1
    this.openaiAdapter = new OpenAICompatibleProtocol({
      baseUrl: `${this.baseUrl}/v1`,
      apiKey: "ollama", // Ollama doesn't require a real API key
      fetchFn: this.fetchFn,
    });
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    return this.openaiAdapter.chat(messages, options);
  }

  async *chatStream(messages: Message[], options: ChatOptions): AsyncIterable<ChatChunk> {
    if (this.openaiAdapter.chatStream) {
      yield* this.openaiAdapter.chatStream(messages, options);
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/tags`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        return [];
      }

      const json = await response.json() as OllamaTagsResponse;

      return (json.models ?? []).map((m) => ({
        modelId: m.name,
        displayName: m.name,
        ownedBy: "ollama",
      }));
    } catch {
      // Ollama is not running — return empty list silently
      return [];
    }
  }
}

// ─── Response Types (internal) ──────────────────────────────────

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    details?: {
      family?: string;
    };
  }>;
}
