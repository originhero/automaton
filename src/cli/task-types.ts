/**
 * Task Types
 *
 * TypeScript interfaces and parsing/serialization functions for the
 * stdin/stdout JSON protocol used by `automaton task` mode.
 *
 * Paperclip sends a TaskInput over stdin; Automaton writes a TaskOutput
 * to stdout when the run completes.
 */

import type { AgentTurn } from "../types.js";
import type { SurvivalTier } from "../types.js";

// ─── Serialized Turn ──────────────────────────────────────────────

export interface SerializedToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface SerializedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface SerializedTurn {
  id: string;
  thinking: string;
  toolCalls: SerializedToolCall[];
  tokenUsage: SerializedTokenUsage;
  costCents: number;
}

// ─── Session State ────────────────────────────────────────────────

export interface TaskInputSession {
  turns: SerializedTurn[];
  kvState: Record<string, string>;
  workdir: string | null;
}

// ─── Task Input Config ────────────────────────────────────────────

export interface TaskInputConfig {
  genesisPrompt?: string;
  inferenceModel?: string;
  maxTurnsPerCycle?: number;
  skills?: string[];
}

// ─── Task Input ───────────────────────────────────────────────────

export interface TaskInput {
  runId: string;
  agentId: string;
  companyId: string;
  prompt: string;
  context?: string;
  /** Session state from the previous cycle, or null for a fresh run. */
  session: TaskInputSession | null;
  /** Optional config overrides. Defaults to {} if not provided by caller. */
  config?: TaskInputConfig;
  /** Top-level model override (used by Paperclip adapter). */
  model?: string;
}

// ─── Task Output ──────────────────────────────────────────────────

export interface TotalUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface TaskOutput {
  success: boolean;
  exitReason: string;
  summary: string;
  turns: SerializedTurn[];
  totalUsage: TotalUsage;
  totalCostCents: number;
  model: string;
  provider: string;
  session: TaskInputSession;
  survivalTier: SurvivalTier;
  creditBalance: number;
}

// ─── Parsing ──────────────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof TaskInput)[] = [
  "runId",
  "agentId",
  "companyId",
  "prompt",
  "session",
];

/**
 * Parse a raw JSON string into a TaskInput, validating all required fields.
 * Throws a descriptive error if the input is invalid.
 */
export function parseTaskInput(raw: string): TaskInput {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`TaskInput JSON parse error: ${(err as Error).message}`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      throw new Error(
        `TaskInput missing required field: "${field}"`
      );
    }
  }

  // Default config to empty object if not provided (Paperclip may omit it)
  if (!("config" in parsed) || parsed.config == null) {
    parsed.config = {};
  }

  // If a top-level `model` was provided but config.inferenceModel was not,
  // propagate it into config so the runner picks it up.
  const configObj = parsed.config as Record<string, unknown>;
  if (
    typeof parsed.model === "string" &&
    (parsed.model as string).trim().length > 0 &&
    !configObj.inferenceModel
  ) {
    configObj.inferenceModel = parsed.model;
  }

  return parsed as unknown as TaskInput;
}

// ─── Serialization ────────────────────────────────────────────────

/**
 * Serialize a TaskOutput to a JSON string for writing to stdout.
 */
export function serializeTaskOutput(output: TaskOutput): string {
  return JSON.stringify(output);
}

/**
 * Map an AgentTurn (internal runtime type) to a SerializedTurn
 * suitable for inclusion in a TaskOutput or TaskInputSession.
 *
 * TokenUsage mapping:
 *   AgentTurn.tokenUsage.promptTokens     → SerializedTurn.tokenUsage.inputTokens
 *   AgentTurn.tokenUsage.completionTokens → SerializedTurn.tokenUsage.outputTokens
 */
export function serializeTurn(turn: AgentTurn): SerializedTurn {
  return {
    id: turn.id,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls.map((tc) => ({
      name: tc.name,
      args: tc.arguments,
      result: tc.result,
    })),
    tokenUsage: {
      inputTokens: turn.tokenUsage.promptTokens,
      outputTokens: turn.tokenUsage.completionTokens,
    },
    costCents: turn.costCents,
  };
}
