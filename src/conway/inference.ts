/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * The automaton pays for its own thinking through Conway credits.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";

const INFERENCE_TIMEOUT_MS = 60_000;

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  ollamaBaseUrl?: string;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
}

type InferenceBackend = "conway" | "openai" | "deepseek" | "anthropic" | "google" | "ollama";

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey, openaiApiKey, anthropicApiKey, googleApiKey, ollamaBaseUrl, getModelProvider } = options;
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
  });
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const backend = resolveInferenceBackend(model, {
      openaiApiKey,
      anthropicApiKey,
      googleApiKey,
      ollamaBaseUrl,
      getModelProvider,
    });

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens.
    // Ollama always uses max_tokens.
    const usesCompletionTokens =
      backend !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (backend === "anthropic") {
      return chatViaAnthropic({
        model,
        tokenLimit,
        messages,
        tools,
        temperature: opts?.temperature,
        anthropicApiKey: anthropicApiKey as string,
        httpClient,
      });
    }

    if (backend === "google") {
      return chatViaGoogle({
        model,
        tokenLimit,
        messages,
        tools,
        temperature: opts?.temperature,
        googleApiKey: googleApiKey as string,
        httpClient,
      });
    }

    const openAiLikeApiUrl =
      backend === "deepseek" ? apiUrl.replace(/\/$/, "") :
      backend === "openai" ? "https://api.openai.com" :
      backend === "ollama" ? (ollamaBaseUrl as string).replace(/\/$/, "") :
      apiUrl;
    const openAiLikeApiKey =
      backend === "deepseek" ? (openaiApiKey || apiKey) :
      backend === "openai" ? (openaiApiKey as string) :
      backend === "ollama" ? "ollama" :
      apiKey;

    return chatViaOpenAiCompatible({
      model,
      body,
      apiUrl: openAiLikeApiUrl,
      apiKey: openAiLikeApiKey,
      backend,
      httpClient,
    });
  };

  /**
   * @deprecated Use InferenceRouter for tier-based model selection.
   * Still functional as a fallback; router takes priority when available.
   */
  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-5-mini";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

// ─── Google Gemini Backend ────────────────────────────────────────

async function chatViaGoogle(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  googleApiKey: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForGoogle(params.messages);

  const body: Record<string, unknown> = {
    contents: transformed.contents,
    generationConfig: {
      maxOutputTokens: params.tokenLimit,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    },
  };

  if (transformed.systemInstruction) {
    body.systemInstruction = transformed.systemInstruction;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = [{
      functionDeclarations: params.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  // Gemini API uses the model name in the URL path.
  // SECURITY NOTE: The API key is passed as a query parameter because the Google
  // generativelanguage.googleapis.com v1beta endpoint requires it for API key auth.
  // This means the key may appear in server access logs and browser history.
  // For production use, consider using OAuth2/service account credentials with the
  // x-goog-api-key header instead, or use the Vertex AI endpoint which supports
  // Bearer token auth. See: https://cloud.google.com/vertex-ai/docs/reference/rest
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${params.googleApiKey}`;

  const resp = await params.httpClient.request(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Inference error (google): ${resp.status}: ${text}`);
  }

  const data = await resp.json() as any;
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error("No candidate returned from Google Gemini API");
  }

  const parts = candidate.content?.parts || [];
  const textParts = parts.filter((p: any) => p.text);
  const functionCallParts = parts.filter((p: any) => p.functionCall);

  const textContent = textParts.map((p: any) => p.text).join("\n").trim();

  const toolCalls: InferenceToolCall[] | undefined =
    functionCallParts.length > 0
      ? functionCallParts.map((p: any, i: number) => ({
          id: `call_google_${i}_${Date.now()}`,
          type: "function" as const,
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        }))
      : undefined;

  if (!textContent && !toolCalls?.length) {
    throw new Error("No content returned from Google Gemini API");
  }

  const promptTokens = data.usageMetadata?.promptTokenCount || 0;
  const completionTokens = data.usageMetadata?.candidatesTokenCount || 0;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: data.usageMetadata?.totalTokenCount || (promptTokens + completionTokens),
  };

  return {
    id: data.modelVersion || "",
    model: params.model,
    message: {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: normalizeGoogleFinishReason(candidate.finishReason),
  };
}

function transformMessagesForGoogle(
  messages: ChatMessage[],
): { systemInstruction?: Record<string, unknown>; contents: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: msg.content || "" }],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      for (const tc of msg.tool_calls || []) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: parseToolArguments(tc.function.arguments),
          },
        });
      }
      if (parts.length === 0) parts.push({ text: "" });
      contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: msg.name || "unknown_function",
            response: { result: msg.content },
          },
        }],
      });
    }
  }

  // Gemini API requires at least one content entry with role "user".
  // If all messages were system-only, inject a minimal user turn.
  if (contents.length === 0) {
    contents.push({
      role: "user",
      parts: [{ text: "Begin." }],
    });
  }

  // Gemini requires the first content to be role "user", not "model".
  // If conversation history starts with an assistant message, prepend a user turn.
  if (contents.length > 0 && (contents[0] as any).role === "model") {
    contents.unshift({
      role: "user",
      parts: [{ text: "Continue." }],
    });
  }

  return {
    systemInstruction: systemParts.length > 0
      ? { parts: [{ text: systemParts.join("\n\n") }] }
      : undefined,
    contents,
  };
}

function normalizeGoogleFinishReason(reason: unknown): string {
  if (typeof reason !== "string") return "stop";
  switch (reason) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY": return "content_filter";
    case "RECITATION": return "content_filter";
    default: return "stop";
  }
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

/**
 * Resolve which backend to use for a model.
 * When InferenceRouter is available, it uses the model registry's provider field.
 * This function is kept for backward compatibility with direct inference calls.
 */
function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    googleApiKey?: string;
    ollamaBaseUrl?: string;
    getModelProvider?: (modelId: string) => string | undefined;
  },
): InferenceBackend {
  // Registry-based routing: most accurate, no name guessing
  if (keys.getModelProvider) {
    const provider = keys.getModelProvider(model);
    if (provider === "ollama" && keys.ollamaBaseUrl) return "ollama";
    if (provider === "anthropic" && keys.anthropicApiKey) return "anthropic";
    if (provider === "deepseek") return "deepseek";
    if (provider === "openai" && keys.openaiApiKey) return "openai";
    if (provider === "google" && keys.googleApiKey) return "google";
    if (provider === "conway") return "conway";
    // provider unknown or key not configured — fall through to heuristics
  }

  // Heuristic fallback (model not in registry yet)
  if (keys.anthropicApiKey && /^claude/i.test(model)) return "anthropic";
  if (/^deepseek/i.test(model)) return "deepseek";
  if (keys.openaiApiKey && /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)) return "openai";
  if (keys.googleApiKey && /^gemini/i.test(model)) return "google";
  return "conway";

}

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  apiUrl: string;
  apiKey: string;
  backend: "conway" | "openai" | "deepseek" | "ollama";
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const resp = await params.httpClient.request(`${params.apiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        params.backend === "openai" || params.backend === "ollama" || params.backend === "deepseek"
          ? `Bearer ${params.apiKey}`
          : params.apiKey,
    },
    body: JSON.stringify(params.body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Inference error (${params.backend}): ${resp.status}: ${text}`,
    );
  }

  const data = await resp.json() as any;
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  anthropicApiKey: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForAnthropic(params.messages);
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.tokenLimit,
    messages:
      transformed.messages.length > 0
        ? transformed.messages
        : (() => { throw new Error("Cannot send empty message array to Anthropic API"); })(),
  };

  if (transformed.system) {
    body.system = transformed.system;
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }

  const resp = await params.httpClient.request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Inference error (anthropic): ${resp.status}: ${text}`);
  }

  const data = await resp.json() as any;
  const content = Array.isArray(data.content) ? data.content : [];
  const textBlocks = content.filter((c: any) => c?.type === "text");
  const toolUseBlocks = content.filter((c: any) => c?.type === "tool_use");

  const toolCalls: InferenceToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((tool: any) => ({
          id: tool.id,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }))
      : undefined;

  const textContent = textBlocks
    .map((block: any) => String(block.text || ""))
    .join("\n")
    .trim();

  if (!textContent && !toolCalls?.length) {
    throw new Error("No completion content returned from anthropic inference");
  }

  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: normalizeAnthropicFinishReason(data.stop_reason),
  };
}

function transformMessagesForAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const transformed: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Merge consecutive user messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = last.content + "\n" + msg.content;
        continue;
      }
      transformed.push({
        role: "user",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const toolCall of msg.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      // Merge consecutive assistant messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(...content);
        continue;
      }
      transformed.push({
        role: "assistant",
        content,
      });
      continue;
    }

    if (msg.role === "tool") {
      // Merge consecutive tool messages into a single user message
      // with multiple tool_result content blocks
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "unknown_tool_call",
        content: msg.content,
      };

      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Append tool_result to existing user message with content blocks
        (last.content as Array<Record<string, unknown>>).push(toolResultBlock);
        continue;
      }

      transformed.push({
        role: "user",
        content: [toolResultBlock],
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: transformed,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeAnthropicFinishReason(reason: unknown): string {
  if (typeof reason !== "string") return "stop";
  if (reason === "tool_use") return "tool_calls";
  return reason;
}
