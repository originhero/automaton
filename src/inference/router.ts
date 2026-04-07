/**
 * Inference Router
 *
 * Routes inference requests through the model registry using
 * tier-based selection, budget enforcement, and provider-specific
 * message transformation.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import { ExpandedModelRegistry, type ExpandedModelEntry } from "./registry.js";
import { InferenceBudgetTracker } from "./budget.js";
import { DEFAULT_ROUTING_MATRIX, TASK_TIMEOUTS } from "./types.js";
import { OpenAICompatibleProtocol } from "./protocols/openai-compatible.js";
import { AnthropicProtocol } from "./protocols/anthropic.js";
import { GoogleProtocol } from "./protocols/google.js";
import { OllamaProtocol } from "./protocols/ollama.js";
import type {
  InferenceProtocol,
  ChatOptions as ProtocolChatOptions,
  ChatResult,
  Message as ProtocolMessage,
} from "./protocols/types.js";
import { InferenceRateLimiter } from "./rate-limiter.js";
import type { RateLimiterConfig } from "./rate-limiter.js";

type Database = BetterSqlite3.Database;

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private budget: InferenceBudgetTracker;
  private rateLimiter: InferenceRateLimiter;

  constructor(
    db: Database,
    registry: ModelRegistry,
    budget: InferenceBudgetTracker,
    rateLimiterConfig?: Partial<RateLimiterConfig>,
  ) {
    this.db = db;
    this.registry = registry;
    this.budget = budget;
    this.rateLimiter = new InferenceRateLimiter(rateLimiterConfig);
  }

  /**
   * Route an inference request: select model, check budget,
   * transform messages, call inference, record cost.
   */
  async route(
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 1. Select model from routing matrix
    const model = this.selectModel(tier, taskType);
    if (!model) {
      return {
        content: "",
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    // 2. Estimate cost and check budget
    const estimatedTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
    const estimatedCostCents = Math.ceil(
      (estimatedTokens / 1000) * model.costPer1kInput / 100 +
      (request.maxTokens || 1000) / 1000 * model.costPer1kOutput / 100,
    );

    const budgetCheck = this.budget.checkBudget(estimatedCostCents, model.modelId);
    if (!budgetCheck.allowed) {
      return {
        content: `Budget exceeded: ${budgetCheck.reason}`,
        model: model.modelId,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "budget_exceeded",
      };
    }

    // 3. Check session budget
    if (request.sessionId && this.budget.config.sessionBudgetCents > 0) {
      const sessionCost = this.budget.getSessionCost(request.sessionId);
      if (sessionCost + estimatedCostCents > this.budget.config.sessionBudgetCents) {
        return {
          content: `Session budget exceeded: ${sessionCost}c spent + ${estimatedCostCents}c estimated > ${this.budget.config.sessionBudgetCents}c limit`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs: 0,
          finishReason: "budget_exceeded",
        };
      }
    }

    // 4. Transform messages for provider
    const transformedMessages = this.transformMessagesForProvider(messages, model.provider);

    // 5. Build inference options
    const preference = this.getPreference(tier, taskType);
    const maxTokens = request.maxTokens || preference?.maxTokens || model.maxTokens;
    const timeout = TASK_TIMEOUTS[taskType] || 120_000;

    const inferenceOptions: any = {
      model: model.modelId,
      maxTokens,
      tools: tools,
    };

    // 6. Rate limit: wait for an available token before calling inference
    await this.rateLimiter.waitForToken(model.provider);

    // 7. Call inference with timeout
    const startTime = Date.now();
    let response: any;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        inferenceOptions.signal = controller.signal;
        response = await inferenceChat(transformedMessages, inferenceOptions);
      } finally {
        clearTimeout(timer);
      }
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      // Record failure with rate limiter
      const retryAfterMs = this.extractRetryAfterMs(error);
      this.rateLimiter.recordFailure(model.provider, retryAfterMs);

      // If fallback is enabled, try next candidate
      if (error.name === "AbortError") {
        return {
          content: `Inference timeout after ${timeout}ms`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs,
          finishReason: "timeout",
        };
      }
      throw error;
    }
    const latencyMs = Date.now() - startTime;

    // Record success with rate limiter
    this.rateLimiter.recordSuccess(model.provider);

    // 8. Calculate actual cost
    const inputTokens = response.usage?.promptTokens || 0;
    const outputTokens = response.usage?.completionTokens || 0;
    const actualCostCents = Math.ceil(
      (inputTokens / 1000) * model.costPer1kInput / 100 +
      (outputTokens / 1000) * model.costPer1kOutput / 100,
    );

    // 9. Record cost
    this.budget.recordCost({
      sessionId,
      turnId: turnId || null,
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      tier,
      taskType,
      cacheHit: false,
    });

    // 10. Build result
    return {
      content: response.message?.content || "",
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason || "stop",
    };
  }

  /**
   * Select the best model for a given tier and task type.
   *
   * Priority:
   *   1. First routing-matrix candidate present in the registry
   *   2. User-configured model(s) from ModelStrategyConfig
   *      (free/Ollama models are allowed at any tier, including dead)
   */
  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    const TIER_ORDER: Record<string, number> = {
      dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4,
    };

    const tierRank = TIER_ORDER[tier] ?? 0;

    // 1. Try routing-matrix candidates
    const preference = this.getPreference(tier, taskType);
    if (preference && preference.candidates.length > 0) {
      for (const candidateId of preference.candidates) {
        const entry = this.registry.get(candidateId);
        if (entry && entry.enabled) {
          return entry;
        }
      }
    }

    // 2. Fall back to user-configured models.
    //    This handles local/Ollama setups where routing-matrix models are absent.
    const strategy = this.budget.config;
    const fallbackIds: (string | undefined)[] =
      tier === "critical" || tier === "dead"
        ? [strategy.criticalModel, strategy.inferenceModel, strategy.lowComputeModel]
        : [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];

    for (const modelId of fallbackIds) {
      if (!modelId) continue;
      const entry = this.registry.get(modelId);
      if (!entry || !entry.enabled) continue;
      const isFree = entry.costPer1kInput === 0 && entry.costPer1kOutput === 0;
      const tierOk = tierRank >= (TIER_ORDER[entry.tierMinimum] ?? 0);
      if (isFree || tierOk) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Transform messages for a specific provider.
   * Handles Anthropic's alternating-role requirement.
   */
  transformMessagesForProvider(messages: ChatMessage[], provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }

    if (provider === "anthropic") {
      return this.fixAnthropicMessages(messages);
    }

    // For OpenAI/Conway, merge consecutive same-role messages
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Fix messages for Anthropic's API requirements:
   * 1. Extract system messages
   * 2. Merge consecutive same-role messages
   * 3. Merge consecutive tool messages into a single user message
   *    with multiple tool_result content blocks
   */
  private fixAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      // System messages are handled separately by the Anthropic client
      if (msg.role === "system") {
        result.push(msg);
        continue;
      }

      // Tool messages become user messages with tool_result content
      if (msg.role === "tool") {
        const last = result[result.length - 1];
        // If previous message was also a tool (now a user), merge into it
        if (last && last.role === "user" && (last as any)._toolResultMerged) {
          // Append to the merged content
          last.content = last.content + "\n[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content;
          continue;
        }
        // Otherwise create a new user message
        const userMsg: ChatMessage & { _toolResultMerged?: boolean } = {
          role: "user",
          content: "[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content,
          _toolResultMerged: true,
        };
        result.push(userMsg);
        continue;
      }

      // For user/assistant: merge with previous if same role
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }

      result.push({ ...msg });
    }

    // Clean up internal markers
    for (const msg of result) {
      delete (msg as any)._toolResultMerged;
    }

    return result;
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }
      result.push({ ...msg });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }

  /**
   * Extract a Retry-After value (in ms) from an error, if present.
   * Handles errors with `headers` (fetch Response-like), `response.headers`,
   * or a numeric `retryAfter` property.
   */
  private extractRetryAfterMs(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;

    const err = error as Record<string, unknown>;

    // Check for a retryAfter property (some SDKs set this directly)
    if (typeof err.retryAfter === "number" && err.retryAfter > 0) {
      return err.retryAfter * 1000;
    }

    // Check for headers (fetch-style error or response object)
    const headers =
      (err.headers as Record<string, unknown>) ??
      ((err.response as Record<string, unknown>)?.headers as Record<string, unknown>);

    if (headers) {
      const getHeader =
        typeof (headers as any).get === "function"
          ? (name: string) => (headers as any).get(name) as string | null
          : (name: string) => (headers as Record<string, string>)[name] ?? null;

      const retryAfterValue = getHeader("retry-after") ?? getHeader("Retry-After");
      return InferenceRateLimiter.parseRetryAfter(retryAfterValue);
    }

    return undefined;
  }

  /**
   * Create the appropriate protocol adapter for a model entry.
   */
  private createProtocolAdapter(model: ExpandedModelEntry, apiKey: string): InferenceProtocol {
    switch (model.protocol) {
      case "openai-compatible":
        return new OpenAICompatibleProtocol({
          baseUrl: model.baseUrl,
          apiKey,
        });
      case "anthropic":
        return new AnthropicProtocol({
          baseUrl: model.baseUrl,
          apiKey,
        });
      case "google":
        return new GoogleProtocol({
          baseUrl: model.baseUrl,
          apiKey,
        });
      case "ollama":
        return new OllamaProtocol({
          baseUrl: model.baseUrl,
        });
      default: {
        const exhaustive: never = model.protocol;
        throw new Error(`Unknown protocol: ${exhaustive}`);
      }
    }
  }

  /**
   * Route an inference request using the protocol-based system.
   * This is the new entry point that replaces the old `route()` method
   * once the migration is complete.
   */
  async routeWithProtocol(
    request: InferenceRequest,
    expandedRegistry: ExpandedModelRegistry,
    resolveApiKey: (provider: string) => string,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 1. Select model from routing matrix (reuse existing logic)
    const legacyModel = this.selectModel(tier, taskType);
    if (!legacyModel) {
      return {
        content: "",
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    // 2. Look up expanded model entry for protocol info
    const expandedModel = expandedRegistry.get(legacyModel.modelId);
    if (!expandedModel) {
      // Fall back to legacy routing
      return this.route(request, async () => {
        throw new Error(`No protocol adapter found for model: ${legacyModel.modelId}`);
      });
    }

    // 3. Get API key for this provider
    const apiKey = resolveApiKey(expandedModel.provider);

    // 4. Create protocol adapter
    const protocol = this.createProtocolAdapter(expandedModel, apiKey);

    // 5. Build protocol options
    const preference = this.getPreference(tier, taskType);
    const maxTokens = request.maxTokens || preference?.maxTokens || expandedModel.maxOutputTokens;

    const protocolOptions: ProtocolChatOptions = {
      model: expandedModel.modelId,
      maxTokens,
      tools: tools as ProtocolChatOptions["tools"],
    };

    // 6. Convert ChatMessage[] to protocol Message[]
    const protocolMessages: ProtocolMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    }));

    // 7. Rate limit: wait for an available token
    await this.rateLimiter.waitForToken(expandedModel.provider);

    // 8. Call protocol adapter
    const startTime = Date.now();
    let result: ChatResult;
    try {
      result = await protocol.chat(protocolMessages, protocolOptions);
    } catch (error: unknown) {
      const latencyMs = Date.now() - startTime;
      // Record failure with rate limiter
      const retryAfterMs = this.extractRetryAfterMs(error);
      this.rateLimiter.recordFailure(expandedModel.provider, retryAfterMs);

      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Protocol error: ${message}`,
        model: expandedModel.modelId,
        provider: expandedModel.provider as ModelProvider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs,
        finishReason: "error",
      };
    }
    const latencyMs = Date.now() - startTime;

    // Record success with rate limiter
    this.rateLimiter.recordSuccess(expandedModel.provider);

    // 9. Calculate cost
    const actualCostCents = Math.ceil(
      (result.inputTokens / 1000) * expandedModel.costPer1kInput / 100 +
      (result.outputTokens / 1000) * expandedModel.costPer1kOutput / 100,
    );

    // 10. Record cost
    this.budget.recordCost({
      sessionId,
      turnId: turnId || null,
      model: expandedModel.modelId,
      provider: expandedModel.provider,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costCents: actualCostCents,
      latencyMs,
      tier,
      taskType,
      cacheHit: false,
    });

    return {
      content: result.content,
      model: result.model,
      provider: expandedModel.provider as ModelProvider,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costCents: actualCostCents,
      latencyMs,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
    };
  }
}
