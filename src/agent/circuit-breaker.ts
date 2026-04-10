/**
 * Circuit Breaker for the Agent Loop
 *
 * Detects degenerate behavior patterns and forces the agent to sleep
 * before wasting credits. Escalates to the owner via KV events that
 * the dashboard/boardroom can surface.
 *
 * Patterns detected:
 * 1. Same tool failing 3+ consecutive times (tool stuck)
 * 2. Excessive spend in a single turn (runaway inference)
 * 3. write_file without subsequent exec (unproductive writes)
 * 4. Monotonic spend with no progress (burning credits for nothing)
 */

import type { AutomatonDatabase } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("circuit-breaker");

/** A tool call outcome for tracking purposes */
export interface ToolOutcome {
  name: string;
  error: string | null;
  costCents: number;
}

/** An escalation event surfaced to the dashboard */
export interface CircuitBreakerEvent {
  type: "tool_stuck" | "spend_anomaly" | "unproductive_writes" | "spend_no_progress";
  severity: "warning" | "critical";
  message: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface CircuitBreakerConfig {
  /** Max consecutive failures of the same tool before tripping (default: 3) */
  maxToolFailures: number;
  /** Max cost in cents for a single turn before flagging (default: 50) */
  maxTurnSpendCents: number;
  /** Max write_file calls without an exec before flagging (default: 5) */
  maxWritesWithoutExec: number;
  /** Number of turns to look back for spend-no-progress detection (default: 5) */
  spendWindowTurns: number;
  /** Min total spend (cents) in window to trigger no-progress check (default: 20) */
  spendWindowMinCents: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxToolFailures: 3,
  maxTurnSpendCents: 50,
  maxWritesWithoutExec: 5,
  spendWindowTurns: 5,
  spendWindowMinCents: 20,
};

export class CircuitBreaker {
  private config: CircuitBreakerConfig;

  // Tool failure tracking: tool name -> consecutive failure count
  private toolFailures: Map<string, number> = new Map();
  private lastFailedTool: string | null = null;

  // Write-without-exec tracking
  private writesWithoutExec = 0;

  // Spend tracking across turns
  private recentTurnSpends: number[] = [];
  private recentTurnMutations: boolean[] = [];

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a completed turn's tool outcomes.
   * Returns a circuit breaker event if a pattern is detected, or null.
   */
  processTurn(
    toolOutcomes: ToolOutcome[],
    turnCostCents: number,
    hadMutation: boolean,
  ): CircuitBreakerEvent | null {
    // Track spend history
    this.recentTurnSpends.push(turnCostCents);
    this.recentTurnMutations.push(hadMutation);
    if (this.recentTurnSpends.length > this.config.spendWindowTurns) {
      this.recentTurnSpends.shift();
      this.recentTurnMutations.shift();
    }

    // Check 1: Same tool failing consecutively
    const stuckEvent = this.checkToolStuck(toolOutcomes);
    if (stuckEvent) return stuckEvent;

    // Check 2: Excessive spend in a single turn
    const spendEvent = this.checkTurnSpend(turnCostCents);
    if (spendEvent) return spendEvent;

    // Check 3: write_file without exec
    const writeEvent = this.checkWritesWithoutExec(toolOutcomes);
    if (writeEvent) return writeEvent;

    // Check 4: Spending credits with no real progress
    const noProgressEvent = this.checkSpendNoProgress();
    if (noProgressEvent) return noProgressEvent;

    return null;
  }

  /**
   * Persist an escalation event to the database KV store so the
   * dashboard can surface it to the owner.
   */
  escalate(db: AutomatonDatabase, event: CircuitBreakerEvent): void {
    // Append to the circuit breaker event log (last 20 events)
    const existing = db.getKV("circuit_breaker_events");
    let events: CircuitBreakerEvent[] = [];
    if (existing) {
      try {
        events = JSON.parse(existing);
      } catch {
        events = [];
      }
    }
    events.push(event);
    if (events.length > 20) {
      events = events.slice(-20);
    }
    db.setKV("circuit_breaker_events", JSON.stringify(events));

    // Set the latest event for quick dashboard polling
    db.setKV("circuit_breaker_latest", JSON.stringify(event));

    logger.warn(`Circuit breaker tripped: ${event.type}`, {
      severity: event.severity,
      message: event.message,
    });
  }

  /** Reset all tracking state (e.g., after a successful productive turn) */
  reset(): void {
    this.toolFailures.clear();
    this.lastFailedTool = null;
    this.writesWithoutExec = 0;
    this.recentTurnSpends = [];
    this.recentTurnMutations = [];
  }

  // ─── Internal Checks ──────────────────────────────────────────

  /**
   * H5 fix — track failures PER TOOL independently, no longer keyed on the
   * single `lastFailedTool` sentinel. Alternating failing tools
   * (exec → write_file → exec → write_file) now correctly trip the breaker
   * on each tool's cumulative count, instead of resetting every switch.
   *
   * Semantics:
   *   - Every failure for tool T increments T's counter
   *   - Every success for tool T resets T's counter
   *   - If any tool's counter >= maxToolFailures, trip
   */
  private checkToolStuck(outcomes: ToolOutcome[]): CircuitBreakerEvent | null {
    for (const outcome of outcomes) {
      if (outcome.error) {
        const count = (this.toolFailures.get(outcome.name) ?? 0) + 1;
        this.toolFailures.set(outcome.name, count);
        this.lastFailedTool = outcome.name;

        if (count >= this.config.maxToolFailures) {
          return {
            type: "tool_stuck",
            severity: "critical",
            message: `Tool "${outcome.name}" has failed ${count} times. Agent is stuck on this tool.`,
            details: {
              tool: outcome.name,
              failures: count,
              lastError: outcome.error,
            },
            timestamp: new Date().toISOString(),
          };
        }
      } else {
        // Successful call resets failure tracking for THIS tool only
        this.toolFailures.delete(outcome.name);
        if (outcome.name === this.lastFailedTool) {
          this.lastFailedTool = null;
        }
      }
    }
    return null;
  }

  private checkTurnSpend(turnCostCents: number): CircuitBreakerEvent | null {
    if (turnCostCents > this.config.maxTurnSpendCents) {
      return {
        type: "spend_anomaly",
        severity: "warning",
        message: `Single turn cost ${turnCostCents}c exceeds limit of ${this.config.maxTurnSpendCents}c.`,
        details: {
          turnCostCents,
          limitCents: this.config.maxTurnSpendCents,
        },
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }

  private checkWritesWithoutExec(outcomes: ToolOutcome[]): CircuitBreakerEvent | null {
    const hasWrite = outcomes.some((o) => o.name === "write_file" || o.name === "edit_own_file");
    const hasExec = outcomes.some((o) => o.name === "exec");

    if (hasWrite && !hasExec) {
      this.writesWithoutExec++;
    } else if (hasExec) {
      // exec resets the counter — agent is testing/running what it wrote
      this.writesWithoutExec = 0;
    }

    if (this.writesWithoutExec >= this.config.maxWritesWithoutExec) {
      const event: CircuitBreakerEvent = {
        type: "unproductive_writes",
        severity: "warning",
        message: `Agent has written files ${this.writesWithoutExec} times without executing anything. Possible unproductive loop.`,
        details: {
          writesWithoutExec: this.writesWithoutExec,
        },
        timestamp: new Date().toISOString(),
      };
      this.writesWithoutExec = 0; // Reset after firing
      return event;
    }

    return null;
  }

  private checkSpendNoProgress(): CircuitBreakerEvent | null {
    if (this.recentTurnSpends.length < this.config.spendWindowTurns) {
      return null;
    }

    const totalSpend = this.recentTurnSpends.reduce((a, b) => a + b, 0);
    const hadAnyMutation = this.recentTurnMutations.some((m) => m);

    if (totalSpend >= this.config.spendWindowMinCents && !hadAnyMutation) {
      return {
        type: "spend_no_progress",
        severity: "critical",
        message: `Spent ${totalSpend}c over ${this.config.spendWindowTurns} turns with zero mutations. Agent is burning credits without progress.`,
        details: {
          totalSpendCents: totalSpend,
          turnsWithoutMutation: this.config.spendWindowTurns,
        },
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }
}
