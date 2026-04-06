/**
 * Google Generative Language Protocol Adapter
 *
 * Covers: Gemini models via Google's Generative Language API.
 *
 * Endpoints:
 *   - chat:   POST {baseUrl}/models/{model}:generateContent
 *   - stream: POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse
 *
 * Key differences:
 *   - API key sent via `x-goog-api-key` header
 *   - Messages use `contents` array with `parts` instead of `content` string
 *   - Assistant role = "model"
 *   - System messages go into `systemInstruction`
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

export interface GoogleConfig {
  baseUrl: string;
  apiKey: string;
  fetchFn?: FetchFn;
}

export class GoogleProtocol implements InferenceProtocol {
  readonly protocol: Protocol = "google";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(config: GoogleConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResult> {
    const { systemInstruction, contents } = this.transformMessages(messages);

    const body: Record<string, unknown> = { contents };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    if (options.maxTokens !== undefined) {
      body.generationConfig = {
        ...(body.generationConfig as Record<string, unknown> ?? {}),
        maxOutputTokens: options.maxTokens,
      };
    }
    if (options.temperature !== undefined) {
      body.generationConfig = {
        ...(body.generationConfig as Record<string, unknown> ?? {}),
        temperature: options.temperature,
      };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    // Bug G fix: use x-goog-api-key header instead of API key in URL query parameter
    const url = `${this.baseUrl}/models/${options.model}:generateContent`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Google API error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    const json = await response.json() as GoogleResponse;
    const candidate = json.candidates?.[0];
    const textParts = candidate?.content?.parts
      ?.filter((p) => p.text !== undefined)
      .map((p) => p.text!)
      ?? [];

    // Bug E fix: parse functionCall parts from responses
    const functionCallParts = candidate?.content?.parts
      ?.filter((p) => p.functionCall !== undefined) ?? [];

    const toolCalls: ToolCall[] | undefined = functionCallParts.length > 0
      ? functionCallParts.map((p) => ({
        id: `call_${p.functionCall!.name}`,
        type: "function" as const,
        function: {
          name: p.functionCall!.name,
          arguments: JSON.stringify(p.functionCall!.args),
        },
      }))
      : undefined;

    return {
      content: textParts.join(""),
      model: options.model,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: candidate?.finishReason ?? "unknown",
      toolCalls,
    };
  }

  async *chatStream(messages: Message[], options: ChatOptions): AsyncIterable<ChatChunk> {
    const { systemInstruction, contents } = this.transformMessages(messages);

    const body: Record<string, unknown> = { contents };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    if (options.maxTokens !== undefined) {
      body.generationConfig = {
        ...(body.generationConfig as Record<string, unknown> ?? {}),
        maxOutputTokens: options.maxTokens,
      };
    }
    if (options.temperature !== undefined) {
      body.generationConfig = {
        ...(body.generationConfig as Record<string, unknown> ?? {}),
        temperature: options.temperature,
      };
    }
    // Bug H fix: pass tools in streaming request body
    if (options.tools && options.tools.length > 0) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    // Bug F fix: use alt=sse for real streaming; Bug G fix: use header instead of query param
    const url = `${this.baseUrl}/models/${options.model}:streamGenerateContent?alt=sse`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Google streaming error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    // Bug F fix: parse SSE events instead of buffering entire JSON response
    if (!response.body) {
      throw new Error("Google streaming error: response body is null");
    }

    const reader = response.body.getReader();
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
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);

          let parsed: GoogleResponse;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const candidate = parsed.candidates?.[0];
          const text = candidate?.content?.parts
            ?.filter((p) => p.text !== undefined)
            .map((p) => p.text!)
            .join("") ?? "";

          // Parse functionCall parts from streaming events
          const functionCallParts = candidate?.content?.parts
            ?.filter((p) => p.functionCall !== undefined) ?? [];

          const toolCalls: ToolCall[] | undefined = functionCallParts.length > 0
            ? functionCallParts.map((p) => ({
              id: `call_${p.functionCall!.name}`,
              type: "function" as const,
              function: {
                name: p.functionCall!.name,
                arguments: JSON.stringify(p.functionCall!.args),
              },
            }))
            : undefined;

          yield {
            delta: text,
            finishReason: candidate?.finishReason ?? undefined,
            toolCalls,
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Google does not expose a public model listing API for Gemini.
   * Discovery relies on the builtin catalog.
   */

  // ─── Internal ───────────────────────────────────────────────────

  private transformMessages(
    messages: Message[],
  ): {
    systemInstruction: GoogleContent | null;
    contents: GoogleContent[];
  } {
    const systemParts: string[] = [];
    const nonSystem: Message[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        if (msg.content) systemParts.push(msg.content);
      } else {
        nonSystem.push(msg);
      }
    }

    // Build contents with proper part types
    const contents: GoogleContent[] = [];

    for (const msg of nonSystem) {
      const googleRole = msg.role === "assistant" ? "model" : msg.role;

      // Bug E fix: tool role messages become functionResponse parts
      if (msg.role === "tool") {
        let responseData: unknown;
        try {
          responseData = JSON.parse(msg.content);
        } catch {
          responseData = { result: msg.content };
        }

        const part: GooglePart = {
          functionResponse: {
            name: msg.name ?? msg.tool_call_id ?? "unknown",
            response: responseData,
          },
        };

        contents.push({ role: "function", parts: [part] });
        continue;
      }

      // Assistant messages with tool_calls become functionCall parts
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: GooglePart[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let args: unknown;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
            },
          });
        }
        contents.push({ role: "model", parts });
        continue;
      }

      // Merge consecutive same-role messages
      const last = contents[contents.length - 1];
      if (last && last.role === googleRole) {
        const existingText = last.parts
          .filter(p => p.text !== undefined)
          .map(p => p.text!)
          .join("");
        last.parts = [{ text: existingText + "\n" + (msg.content ?? "") }];
        continue;
      }

      contents.push({
        role: googleRole === "tool" ? "function" : googleRole,
        parts: [{ text: msg.content ?? "" }],
      });
    }

    const systemInstruction: GoogleContent | null =
      systemParts.length > 0
        ? { role: "user", parts: [{ text: systemParts.join("\n") }] }
        : null;

    return { systemInstruction, contents };
  }

  // Bug G fix: headers with API key
  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
    };
  }
}

// ─── Response Types (internal) ──────────────────────────────────

// Bug I fix: updated types to include functionCall/functionResponse parts
interface GooglePart {
  text?: string;
  functionCall?: {
    name: string;
    args: unknown;
  };
  functionResponse?: {
    name: string;
    response: unknown;
  };
}

interface GoogleContent {
  role: string;
  parts: GooglePart[];
}

interface GoogleResponse {
  candidates?: Array<{
    content?: {
      role: string;
      parts: GooglePart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
}
