/**
 * Task Runner
 *
 * Executes a single Paperclip task using Automaton's agent loop.
 * Collects turns, aggregates usage, and produces structured TaskOutput.
 *
 * The runAgentLoop dependency is injected so this module is testable
 * without booting the full agent stack.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AutomatonIdentity,
  AgentState,
  AgentTurn,
  InputSource,
} from "../types.js";
import type {
  SerializedTurn,
  TaskInput,
  TaskOutput,
  TaskInputSession,
  TotalUsage,
} from "./task-types.js";
import { serializeTurn } from "./task-types.js";
import { getSurvivalTier } from "../conway/credits.js";

// ─── Dependency Injection ──────────────────────────────────────────

/**
 * Options passed to the injected runAgentLoop function.
 * Mirrors the subset of AgentLoopOptions that the task runner controls.
 */
export interface AgentLoopRunOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  input: string;
  inputSource: InputSource;
  maxTurns: number;
  onTurn: (turn: AgentTurn) => void;
}

/**
 * Result returned by the injected runAgentLoop function.
 */
export interface AgentLoopResult {
  turns: AgentTurn[];
  finalState: AgentState;
}

/**
 * Dependencies injected into runTask. Keeping these explicit makes the
 * runner unit-testable: callers can substitute a mock runAgentLoop.
 */
export interface TaskRunnerDeps {
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  identity: AutomatonIdentity;
  runAgentLoop: (options: AgentLoopRunOptions) => Promise<AgentLoopResult>;
}

// ─── Options ───────────────────────────────────────────────────────

export interface RunTaskOptions {
  maxTurns: number;
  timeoutMs: number;
}

// ─── Pure Helpers ──────────────────────────────────────────────────

/**
 * Aggregate token usage and cost across a list of serialized turns.
 */
export function aggregateUsage(turns: SerializedTurn[]): {
  totalUsage: TotalUsage;
  totalCostCents: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let totalCostCents = 0;

  for (const turn of turns) {
    inputTokens += turn.tokenUsage.inputTokens;
    outputTokens += turn.tokenUsage.outputTokens;
    cachedInputTokens += turn.tokenUsage.cachedInputTokens ?? 0;
    totalCostCents += turn.costCents;
  }

  return {
    totalUsage: { inputTokens, outputTokens, cachedInputTokens },
    totalCostCents,
  };
}

/**
 * Map agent execution state + conditions to a structured exit reason string.
 *
 * Priority order: sleeping > timeout > max_turns > completed
 */
export function mapExitReason(
  finalState: AgentState,
  timedOut: boolean,
  turnsExecuted: number,
  maxTurns: number,
): "completed" | "max_turns" | "timeout" | "error" | "sleeping" {
  // Error state means the agent encountered a fatal error
  if (finalState === "error") return "error";
  // Sleeping (or dead) means the agent chose to stop
  if (finalState === "sleeping" || finalState === "dead") return "sleeping";
  // Timeout takes precedence over max_turns
  if (timedOut) return "timeout";
  // Hit the turn ceiling
  if (turnsExecuted >= maxTurns) return "max_turns";
  // Normal finish
  return "completed";
}

// ─── Session Helpers ───────────────────────────────────────────────

/**
 * Detect the provider name from the inference model string.
 * e.g. "claude-3-opus" → "anthropic", "gpt-4o" → "openai"
 */
export function detectProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("llama") || m.startsWith("mistral") || m.startsWith("mixtral")) return "ollama";
  return "unknown";
}

/**
 * Restore session state from a prior cycle into the database KV store.
 */
export function restoreSession(
  db: AutomatonDatabase,
  session: TaskInputSession,
): void {
  for (const [key, value] of Object.entries(session.kvState)) {
    db.setKV(key, value);
  }
  if (session.workdir) {
    db.setKV("__workdir__", session.workdir);
  }
}

/**
 * Capture current session state from the database KV store.
 *
 * KNOWN LIMITATION: kvState is always empty because AutomatonDatabase does not
 * expose a listKV() method. Keys written by the agent during its run are stored
 * in the DB but cannot be enumerated here. The workdir is captured explicitly
 * via the `__workdir__` sentinel key. A future AutomatonDatabase.listKV() API
 * would allow full KV state capture.
 */
export function captureSession(
  db: AutomatonDatabase,
  turns: SerializedTurn[],
): TaskInputSession {
  // Gather all KV entries (excluding internal keys)
  const kvState: Record<string, string> = {};
  // The database interface doesn't expose a listKV, so we track keys set
  // during session restore plus any the agent wrote. For now we emit the
  // workdir and any keys the agent stored during its run.
  const workdir = db.getKV("__workdir__") ?? null;

  return {
    turns,
    kvState,
    workdir,
  };
}

/**
 * Build a brief summary from the agent turns.
 */
export function buildSummary(turns: SerializedTurn[]): string {
  if (turns.length === 0) return "No turns executed.";
  const lastTurn = turns[turns.length - 1];
  const thinking = lastTurn.thinking?.trim();
  if (thinking && thinking.length > 0) {
    return thinking.length > 200
      ? thinking.slice(0, 200) + "..."
      : thinking;
  }
  return `Completed ${turns.length} turn${turns.length === 1 ? "" : "s"}.`;
}

// ─── Main Entry Point ─────────────────────────────────────────────

/**
 * Run a single Paperclip task through the agent loop.
 *
 * 1. Applies config overrides from input
 * 2. Restores session state if provided
 * 3. Runs agent loop with timeout
 * 4. Collects turns via onTurn callback
 * 5. Returns TaskOutput with aggregated usage, session capture, survival tier
 */
export async function runTask(
  input: TaskInput,
  deps: TaskRunnerDeps,
  options: RunTaskOptions,
): Promise<TaskOutput> {
  const { config: baseConfig, db, conway, inference, identity, runAgentLoop } = deps;
  const { maxTurns, timeoutMs } = options;

  // ── 1. Apply config overrides from TaskInput ───────────────────
  const inputConfig = input.config ?? {};
  const config: AutomatonConfig = {
    ...baseConfig,
    ...(inputConfig.genesisPrompt !== undefined
      ? { genesisPrompt: inputConfig.genesisPrompt }
      : {}),
    ...(inputConfig.inferenceModel !== undefined
      ? { inferenceModel: inputConfig.inferenceModel }
      : {}),
    ...(inputConfig.maxTurnsPerCycle !== undefined
      ? { maxTurnsPerCycle: inputConfig.maxTurnsPerCycle }
      : {}),
    agentId: input.agentId,
  };

  // Effective max turns: task option > config override > base default
  const effectiveMaxTurns = options.maxTurns;

  // ── 2. Restore session state if provided ──────────────────────
  if (input.session) {
    restoreSession(db, input.session);
  }

  // ── 3. Run agent loop with timeout ────────────────────────────
  const collectedTurns: AgentTurn[] = [];
  let timedOut = false;

  // Build the full prompt, optionally prepending context
  const fullPrompt = input.context
    ? `${input.context}\n\n${input.prompt}`
    : input.prompt;

  let loopResult: AgentLoopResult;

  const loopPromise = runAgentLoop({
    identity,
    config,
    db,
    conway,
    inference,
    input: fullPrompt,
    inputSource: "creator",
    maxTurns: effectiveMaxTurns,
    onTurn: (turn) => collectedTurns.push(turn),
  });

  // KNOWN LIMITATION: The timeout only races against the loop promise; it does
  // not abort the underlying agent loop. The loop will continue running in the
  // background until it finishes naturally. In practice, this is acceptable
  // because the Paperclip adapter runs Automaton as a child process and kills
  // the entire process tree when the timeout fires. Within a single process,
  // a cooperative cancellation token would be needed to truly cancel the loop.
  if (timeoutMs > 0) {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error("Task timed out"));
      }, timeoutMs);
    });

    try {
      loopResult = await Promise.race([loopPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut) {
        // Timeout — snapshot the collected turns so that any turns arriving
        // after the timeout (from the still-running loop) don't mutate the
        // result we're about to serialize.
        loopResult = { turns: [...collectedTurns], finalState: "running" };
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeoutHandle!);
    }
  } else {
    loopResult = await loopPromise;
  }

  // ── 4. Serialize turns ────────────────────────────────────────
  const serializedTurns: SerializedTurn[] = loopResult.turns.map(serializeTurn);

  // ── 5. Build output ───────────────────────────────────────────
  const exitReason = mapExitReason(
    loopResult.finalState,
    timedOut,
    loopResult.turns.length,
    effectiveMaxTurns,
  );

  const { totalUsage, totalCostCents } = aggregateUsage(serializedTurns);

  const session = captureSession(db, serializedTurns);

  // Determine credit balance and survival tier
  let creditBalance = 0;
  try {
    creditBalance = await conway.getCreditsBalance();
  } catch {
    // Non-fatal: use 0 if credits check fails
  }
  const survivalTier = getSurvivalTier(creditBalance);

  const model = config.inferenceModel;
  const provider = detectProvider(model);

  const summary = buildSummary(serializedTurns);

  return {
    success: exitReason !== "error",
    exitReason,
    summary,
    turns: serializedTurns,
    totalUsage,
    totalCostCents,
    model,
    provider,
    session,
    survivalTier,
    creditBalance,
  };
}
