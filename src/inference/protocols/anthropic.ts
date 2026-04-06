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

const DEFAULT_TIMEOUT_MS = 30_000;

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
      signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
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
      signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Anthropic streaming error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    // Bug D fix: null check on response.body
    if (!response.body) {
      throw new Error("Anthropic streaming error: response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let messageStopReason: string | undefined;

    // Bug B fix: track tool_use blocks being built across events
    const pendingToolCalls: Map<number, { id: string; name: string; inputJson: string }> = new Map();

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

          // Bug C fix: capture stop_reason from message_start or message_delta
          if (parsed.type === "message_start") {
            // stop_reason may appear later in message_delta
            if (parsed.message?.stop_reason) {
              messageStopReason = parsed.message.stop_reason;
            }
          } else if (parsed.type === "message_delta") {
            if (parsed.delta?.stop_reason) {
              messageStopReason = parsed.delta.stop_reason;
            }
          } else if (parsed.type === "content_block_start") {
            // Bug B fix: handle tool_use content block starts
            const contentBlock = parsed.content_block;
            if (contentBlock?.type === "tool_use") {
              pendingToolCalls.set(parsed.index ?? 0, {
                id: contentBlock.id ?? "",
                name: contentBlock.name ?? "",
                inputJson: "",
              });
            }
          } else if (parsed.type === "content_block_delta") {
            const delta = parsed.delta;
            if (delta?.type === "text_delta") {
              yield { delta: delta.text ?? "" };
            } else if (delta?.type === "input_json_delta") {
              // Bug B fix: accumulate tool input JSON fragments
              const pending = pendingToolCalls.get(parsed.index ?? 0);
              if (pending) {
                pending.inputJson += delta.partial_json ?? "";
              }
            }
          } else if (parsed.type === "content_block_stop") {
            // Bug B fix: emit completed tool call when content block ends
            const pending = pendingToolCalls.get(parsed.index ?? 0);
            if (pending) {
              let parsedInput: unknown;
              try {
                parsedInput = JSON.parse(pending.inputJson || "{}");
              } catch {
                parsedInput = {};
              }
              yield {
                delta: "",
                toolCalls: [{
                  id: pending.id,
                  type: "function" as const,
                  function: {
                    name: pending.name,
                    arguments: JSON.stringify(parsedInput),
                  },
                }],
              };
              pendingToolCalls.delete(parsed.index ?? 0);
            }
          } else if (parsed.type === "message_stop") {
            // Bug C fix: use actual stop_reason instead of hardcoded "end_turn"
            yield { delta: "", finishReason: messageStopReason ?? "end_turn" };
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

    // 2. Convert to Anthropic format with proper content blocks
    const processed: Record<string, unknown>[] = [];

    for (const msg of nonSystem) {
      // Bug A fix: tool messages become user messages with tool_result content blocks
      if (msg.role === "tool") {
        const toolResultBlock = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "unknown",
          content: msg.content,
        };

        // If the previous message is already a user message with content array, merge
        const last = processed[processed.length - 1];
        if (last && last.role === "user" && Array.isArray(last.content)) {
          (last.content as unknown[]).push(toolResultBlock);
          continue;
        }

        processed.push({ role: "user", content: [toolResultBlock] });
        continue;
      }

      // Bug A fix: assistant messages with tool_calls preserve tool_use blocks
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const contentBlocks: unknown[] = [];
        if (msg.content) {
          contentBlocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        processed.push({ role: "assistant", content: contentBlocks });
        continue;
      }

      // Merge consecutive same-role messages (only for plain text messages)
      const last = processed[processed.length - 1];
      if (last && last.role === msg.role && typeof last.content === "string") {
        last.content = (last.content as string) + "\n" + (msg.content ?? "");
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
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  message?: {
    id: string;
    model: string;
    stop_reason?: string;
    usage?: { input_tokens: number };
  };
}
