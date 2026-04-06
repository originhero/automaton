/**
 * OpenAI-Compatible Protocol Adapter
 *
 * Covers: OpenAI, DeepSeek, xAI/Grok, Mistral, Groq, Together, OpenRouter,
 * and any provider that exposes the OpenAI Chat Completions API format.
 *
 * Endpoints:
 *   - chat:       POST {baseUrl}/chat/completions
 *   - stream:     POST {baseUrl}/chat/completions (stream: true, SSE)
 *   - listModels: GET  {baseUrl}/models
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
  ToolCall,
} from "./types.js";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  fetchFn?: FetchFn;
}

export class OpenAICompatibleProtocol implements InferenceProtocol {
  readonly protocol: Protocol = "openai-compatible";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(config: OpenAICompatibleConfig) {
    // Strip trailing slash from baseUrl
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    const merged = mergeConsecutiveSameRole(messages);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: merged.map(messageToOpenAI),
    };

    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `OpenAI-compatible API error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    const json = await response.json() as OpenAIChatResponse;
    const choice = json.choices?.[0];

    return {
      content: choice?.message?.content ?? "",
      model: json.model ?? options.model,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      finishReason: choice?.finish_reason ?? "unknown",
      toolCalls: choice?.message?.tool_calls?.map(tc => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }

  async *chatStream(messages: Message[], options: ChatOptions): AsyncIterable<ChatChunk> {
    const merged = mergeConsecutiveSameRole(messages);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: merged.map(messageToOpenAI),
      stream: true,
    };

    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `OpenAI-compatible streaming error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") return;

          let parsed: OpenAIStreamChunk;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          const finishReason = parsed.choices?.[0]?.finish_reason ?? undefined;

          const toolCalls: ToolCall[] | undefined = delta?.tool_calls?.map(tc => ({
            id: tc.id ?? "",
            type: tc.type ?? "function",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          }));

          yield {
            delta: delta?.content ?? "",
            finishReason: finishReason ?? undefined,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const response = await this.fetchFn(`${this.baseUrl}/models`, {
      method: "GET",
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as { data: OpenAIModel[] };

    return (json.data ?? []).map(m => ({
      modelId: m.id,
      displayName: m.id,
      ownedBy: m.owned_by,
    }));
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}

// ─── Message Merging ────────────────────────────────────────────

export function mergeConsecutiveSameRole(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];
    if (
      last &&
      last.role === msg.role &&
      msg.role !== "system" &&
      msg.role !== "tool"
    ) {
      last.content = (last.content ?? "") + "\n" + (msg.content ?? "");
      if (msg.tool_calls) {
        last.tool_calls = [...(last.tool_calls ?? []), ...msg.tool_calls];
      }
      continue;
    }
    result.push({ ...msg });
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────

function messageToOpenAI(msg: Message): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.name) out.name = msg.name;
  if (msg.tool_calls && msg.tool_calls.length > 0) out.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  return out;
}

// ─── Response Types (internal) ──────────────────────────────────

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

interface OpenAIModel {
  id: string;
  owned_by: string;
}
