/**
 * Google Generative Language Protocol Adapter
 *
 * Covers: Gemini models via Google's Generative Language API.
 *
 * Endpoints:
 *   - chat:   POST {baseUrl}/models/{model}:generateContent?key={apiKey}
 *   - stream: POST {baseUrl}/models/{model}:streamGenerateContent?key={apiKey}
 *
 * Key differences:
 *   - API key as query parameter, not header
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
} from "./types.js";

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

    const url = `${this.baseUrl}/models/${options.model}:generateContent?key=${this.apiKey}`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
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

    return {
      content: textParts.join(""),
      model: options.model,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: candidate?.finishReason ?? "unknown",
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

    const url = `${this.baseUrl}/models/${options.model}:streamGenerateContent?key=${this.apiKey}`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Google streaming error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    // Google streaming returns a JSON array of response objects
    const jsonArray = await response.json() as GoogleResponse[];

    for (const item of jsonArray) {
      const candidate = item.candidates?.[0];
      const text = candidate?.content?.parts
        ?.filter((p) => p.text !== undefined)
        .map((p) => p.text!)
        .join("") ?? "";

      yield {
        delta: text,
        finishReason: candidate?.finishReason ?? undefined,
      };
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

    // Merge consecutive same-role messages
    const merged: { role: string; content: string }[] = [];
    for (const msg of nonSystem) {
      const googleRole = msg.role === "assistant" ? "model" : msg.role;
      const last = merged[merged.length - 1];
      if (last && last.role === googleRole) {
        last.content = last.content + "\n" + (msg.content ?? "");
        continue;
      }
      merged.push({ role: googleRole, content: msg.content ?? "" });
    }

    const contents: GoogleContent[] = merged.map((m) => ({
      role: m.role,
      parts: [{ text: m.content }],
    }));

    const systemInstruction: GoogleContent | null =
      systemParts.length > 0
        ? { role: "user", parts: [{ text: systemParts.join("\n") }] }
        : null;

    return { systemInstruction, contents };
  }
}

// ─── Response Types (internal) ──────────────────────────────────

interface GoogleContent {
  role: string;
  parts: Array<{ text: string }>;
}

interface GoogleResponse {
  candidates?: Array<{
    content?: {
      role: string;
      parts: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
}
