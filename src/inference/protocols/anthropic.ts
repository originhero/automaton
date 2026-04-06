/**
 * Anthropic Protocol Adapter
 *
 * Covers: Claude models via Anthropic Messages API.
 *
 * Endpoints:
 *   - chat:   POST {baseUrl}/v1/messages
 *   - stream: POST {baseUrl}/v1/messages (stream: true, SSE)
 *
 * Key differences from OpenAI:
 *   - System messages extracted into top-level `system` parameter
 *   - Tool results sent as user messages with tool_result content
 *   - Uses `x-api-key` header instead of Bearer token
 *   - Streaming uses event types: message_start, content_block_delta, message_stop
 */

import type {
  InferenceProtocol,
  Protocol,
  Message,
  ChatOptions,
  ChatResult,
  ChatChunk,
  FetchFn,
  ToolCall,
} from "./types.js";

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  anthropicVersion?: string;
  fetchFn?: FetchFn;
}

export class AnthropicProtocol implements InferenceProtocol {
  readonly protocol: Protocol = "anthropic";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly fetchFn: FetchFn;

  constructor(config: AnthropicConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    const { systemPrompt, processedMessages } = this.preprocessMessages(messages);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: processedMessages,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Anthropic API error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    const json = await response.json() as AnthropicResponse;

    const textContent = json.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? "";

    const toolCalls: ToolCall[] | undefined = json.content
      ?.filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id!,
        type: "function" as const,
        function: {
          name: block.name!,
          arguments: JSON.stringify(block.input),
        },
      }));

    return {
      content: textContent,
      model: json.model ?? options.model,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      finishReason: json.stop_reason ?? "unknown",
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async *chatStream(messages: Message[], options: ChatOptions): AsyncIterable<ChatChunk> {
    const { systemPrompt, processedMessages } = this.preprocessMessages(messages);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: processedMessages,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Anthropic streaming error ${response.status} ${response.statusText}: ${errorText}`,
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
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith("event: ")) {
            continue;
          }

          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);

          let parsed: AnthropicStreamEvent;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          if (parsed.type === "content_block_delta") {
            const delta = parsed.delta;
            if (delta?.type === "text_delta") {
              yield { delta: delta.text ?? "" };
            }
          } else if (parsed.type === "message_stop") {
            yield { delta: "", finishReason: "end_turn" };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Anthropic does not expose a model discovery API.
   * Discovery relies on the builtin catalog for Anthropic models.
   */

  // ─── Internal ───────────────────────────────────────────────────

  private preprocessMessages(
    messages: Message[],
  ): { systemPrompt: string | null; processedMessages: Record<string, unknown>[] } {
    // 1. Extract system messages
    const systemParts: string[] = [];
    const nonSystem: Message[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        if (msg.content) systemParts.push(msg.content);
      } else {
        nonSystem.push(msg);
      }
    }

    // 2. Convert tool messages to user messages, merge consecutive same-role
    const processed: Record<string, unknown>[] = [];

    for (const msg of nonSystem) {
      if (msg.role === "tool") {
        // Tool results become user messages with tool_result content blocks
        const toolContent = `[tool_result:${msg.tool_call_id ?? "unknown"}] ${msg.content}`;
        const last = processed[processed.length - 1];
        if (last && last.role === "user") {
          // Merge into existing user message
          last.content = (last.content as string) + "\n" + toolContent;
          continue;
        }
        processed.push({ role: "user", content: toolContent });
        continue;
      }

      // Merge consecutive same-role messages
      const last = processed[processed.length - 1];
      if (last && last.role === msg.role) {
        last.content = ((last.content as string) ?? "") + "\n" + (msg.content ?? "");
        continue;
      }

      processed.push({ role: msg.role, content: msg.content });
    }

    return {
      systemPrompt: systemParts.length > 0 ? systemParts.join("\n") : null,
      processedMessages: processed,
    };
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      "Content-Type": "application/json",
    };
  }
}

// ─── Response Types (internal) ──────────────────────────────────

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{
    type: "text" | "tool_use";
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: {
    type?: string;
    text?: string;
  };
  message?: {
    id: string;
    model: string;
    usage?: { input_tokens: number };
  };
}
