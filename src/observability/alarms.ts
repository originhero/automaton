/**
 * Detection alarms — the "watchdog" layer of the hardening sprint.
 *
 * Philosophy (from the 2026-04-10 retrospective):
 *   Prevention is necessary but not sufficient. Every fix in the sprint
 *   so far (C3 allowlist, C4 auth, C11 Stripe lock, etc.) is preventive.
 *   If one of them breaks silently in production — because of a refactor,
 *   a SDK upgrade, or an unfinished fix — the operator has no signal
 *   until the damage is done.
 *
 *   Detection alarms catch the failure mode AT THE TIME IT HAPPENS.
 *   They are the second line of defense: when prevention fails, the
 *   operator gets paged instead of discovering the breach days later.
 *
 * The 5 alarms in this module, each mapped to a failure mode:
 *
 *   1. Spend alarm           — agent destructively consuming credits
 *                              (covers C6 descoped vector + any runaway
 *                              inference bug that the budget tracker
 *                              doesn't catch quickly enough)
 *
 *   2. Duplicate revenue     — Stripe idempotency (C11) breaking under
 *                              concurrent pollers
 *
 *   3. Authority breach      — C13 actor-based check being bypassed
 *                              (someone passing actor:"owner" from an
 *                              untrusted context)
 *
 *   4. Child credit overflow — replication (C10) where a child agent
 *                              outspends its allocation
 *
 *   5. Stuck-in-running      — agent alive but not making progress
 *                              (circuit breaker bug, deadlock in
 *                              state lock, etc.)
 *
 * Each alarm is a pure function that takes a state snapshot and returns
 * an `AlarmSignal | null`. The caller (heartbeat task, event handler,
 * etc.) is responsible for emitting the signal to wherever the operator
 * can see it (logs, dashboard, webhook, push notification).
 *
 * Integration points are documented as TODO(audit-followup) comments
 * at each call site.
 */

export type AlarmSeverity = "info" | "warning" | "critical";
export type AlarmCategory =
  | "spend"
  | "revenue"
  | "authority"
  | "replication"
  | "liveness";

export interface AlarmSignal {
  /** Short machine-readable id for grouping/deduplication. */
  id: string;
  /** Severity tier — drives UI color, paging decisions, etc. */
  severity: AlarmSeverity;
  category: AlarmCategory;
  /** Human-readable title for the alert. */
  title: string;
  /** One-sentence description of what happened. */
  detail: string;
  /** ISO timestamp when the alarm fired. */
  firedAt: string;
  /** Free-form metadata for debugging (don't put secrets here). */
  meta?: Record<string, unknown>;
}

function signal(input: Omit<AlarmSignal, "firedAt">): AlarmSignal {
  return { ...input, firedAt: new Date().toISOString() };
}

// ─── 1. Spend alarm ───────────────────────────────────────────────────
//
// Fires when the current hour's spend exceeds a multiple of the rolling
// 24-hour baseline. A sudden 3x spike is almost always a bug, a rogue
// agent, or a compromised API key — not legitimate usage growth.
//
// TODO(audit-followup): wire this into the heartbeat scheduler as a
//   new task `spend_anomaly_check` that runs every 5 minutes. The
//   hourlyCents and baselineCentsPerHour should be fetched from the
//   inference_costs table via a SUM(cost_cents) GROUP BY hour query.
//   Location: automaton-fork/src/heartbeat/tasks.ts

export interface SpendAlarmInput {
  /** Cents spent in the current hour so far. */
  currentHourCents: number;
  /** Rolling average cents per hour over the last 24 hours. */
  baselineCentsPerHour: number;
  /** Multiplier that triggers the alarm. Default: 3x. */
  multiplier?: number;
  /** Minimum cents to fire — prevents noise when baseline is near zero. */
  minTriggerCents?: number;
}

export function checkSpendAlarm(input: SpendAlarmInput): AlarmSignal | null {
  const multiplier = input.multiplier ?? 3;
  const minTrigger = input.minTriggerCents ?? 50; // 50 cents minimum

  if (input.currentHourCents < minTrigger) return null;
  if (input.baselineCentsPerHour <= 0) return null;

  const ratio = input.currentHourCents / input.baselineCentsPerHour;
  if (ratio < multiplier) return null;

  return signal({
    id: "spend_anomaly",
    severity: ratio >= multiplier * 2 ? "critical" : "warning",
    category: "spend",
    title: `Hourly spend is ${ratio.toFixed(1)}x baseline`,
    detail:
      `Current hour: ${input.currentHourCents}¢ vs baseline ` +
      `${input.baselineCentsPerHour.toFixed(0)}¢/hour. ` +
      `Agent may be stuck in a loop or compromised.`,
    meta: {
      currentHourCents: input.currentHourCents,
      baselineCentsPerHour: input.baselineCentsPerHour,
      ratio,
      multiplier,
    },
  });
}

// ─── 2. Duplicate revenue alarm ───────────────────────────────────────
//
// Fires when the same Stripe chargeId appears twice in the revenue
// ledger within a short window. C11 fix (Stripe poll mutex) should
// prevent this — if the alarm fires, C11 is broken.
//
// TODO(audit-followup): wire this into financial-governance's Stripe
//   poller. After writing revenue to the ledger, query:
//     SELECT COUNT(*) FROM revenue_ledger
//     WHERE charge_id = ? AND created_at > datetime('now', '-5 minutes')
//   If the count is >1, fire this alarm.
//   Location: modules/financial-governance/src/worker.ts (Stripe poller)

export interface DuplicateRevenueInput {
  chargeId: string;
  /** How many times this charge_id appears in the ledger in the window. */
  occurrenceCount: number;
  /** Minutes in the look-back window. */
  windowMinutes: number;
}

export function checkDuplicateRevenue(
  input: DuplicateRevenueInput,
): AlarmSignal | null {
  if (input.occurrenceCount <= 1) return null;

  return signal({
    id: `duplicate_revenue_${input.chargeId}`,
    severity: "critical",
    category: "revenue",
    title: "Duplicate Stripe charge detected in revenue ledger",
    detail:
      `Charge ${input.chargeId} was recorded ${input.occurrenceCount} times ` +
      `in the last ${input.windowMinutes}m. The C11 Stripe poll mutex is ` +
      `likely broken — verify the financial-governance lock is acquired ` +
      `by both the manual action and the scheduled job.`,
    meta: {
      chargeId: input.chargeId,
      occurrenceCount: input.occurrenceCount,
      windowMinutes: input.windowMinutes,
    },
  });
}

// ─── 3. Authority breach alarm ────────────────────────────────────────
//
// Fires when update-governance-config is invoked with an attempt to
// change enforcementMode but WITHOUT actor === "owner". This is the
// exact scenario C13 defends against. Each rejection is logged today
// (see financial-governance/worker.ts); this alarm elevates that log
// entry to a structured signal with severity.
//
// TODO(audit-followup): import and call `checkAuthorityBreach` from the
//   `update-governance-config` action handler right before returning
//   the rejection. The current `ctx.logger.warn` call is searchable but
//   doesn't carry severity metadata for paging.
//   Location: modules/financial-governance/src/worker.ts

export interface AuthorityBreachInput {
  action: string;
  fieldAttempted: string;
  attemptedValue: string;
  currentValue: string;
  actor: unknown;
  companyId: string;
}

/**
 * Render the actor for display WITHOUT leaking its contents.
 *
 * The actor can be anything — string, object, proxy, or a secret-shaped
 * value injected by a malicious caller. We must include enough info
 * for the operator to debug ("what was passed?") without logging keys,
 * tokens, or PII that happened to be in the object.
 *
 * Rules:
 *   - strings: redacted if they look like a secret (sk-*, long random),
 *     otherwise shown as `"value"`.
 *   - primitives: shown with typeof + literal (null, 0, false, etc.)
 *   - objects: shown as `[object with N keys]` — NEVER serialized.
 */
function safeActorDescription(actor: unknown): string {
  if (actor === null) return "null";
  if (actor === undefined) return "undefined";
  if (typeof actor === "string") {
    // Redact anything that looks secret-shaped
    if (actor.length > 40 || /^sk-|^pk-|^Bearer /.test(actor)) {
      return `"<redacted ${actor.length}-char string>"`;
    }
    return `"${actor}"`;
  }
  if (typeof actor === "object") {
    const keys = Object.keys(actor as Record<string, unknown>);
    return `[object with ${keys.length} keys]`;
  }
  return `${typeof actor}(${String(actor)})`;
}

export function checkAuthorityBreach(
  input: AuthorityBreachInput,
): AlarmSignal {
  // Always fires — this function is called only on confirmed rejection
  return signal({
    id: `authority_breach_${input.action}_${input.companyId}`,
    severity: "critical",
    category: "authority",
    title: `Unauthorized attempt to change ${input.fieldAttempted}`,
    detail:
      `Action ${input.action} attempted to change ${input.fieldAttempted} ` +
      `from "${input.currentValue}" to "${input.attemptedValue}" with ` +
      `actor=${safeActorDescription(input.actor)}. Rejected. This may ` +
      `indicate a compromised agent or an intentional bypass attempt — ` +
      `investigate the caller.`,
    meta: {
      action: input.action,
      fieldAttempted: input.fieldAttempted,
      attemptedValue: input.attemptedValue,
      currentValue: input.currentValue,
      // Only the TYPE of the actor — never the value, which may carry
      // secret-shaped objects injected by a malicious caller.
      actorType: typeof input.actor,
      companyId: input.companyId,
    },
  });
}

// ─── 4. Child credit overflow alarm ───────────────────────────────────
//
// Fires when a spawned child agent has spent more than 120% of its
// allocated credit budget. Indicates either (a) the parent didn't
// enforce its allocation, (b) the child is exfiltrating credits via a
// loop, or (c) the accounting is broken.
//
// TODO(audit-followup): wire this into the replication health check
//   that runs every 60 seconds. The parent should fetch each child's
//   cumulative spend via conway.getChildBalance() and compare against
//   the recorded allocation in the `children` table.
//   Location: automaton-fork/src/replication/health.ts

export interface ChildOverflowInput {
  childId: string;
  childName: string;
  allocatedCents: number;
  spentCents: number;
  /** Threshold multiplier over allocation. Default: 1.2 (120%). */
  threshold?: number;
}

export function checkChildOverflow(
  input: ChildOverflowInput,
): AlarmSignal | null {
  const threshold = input.threshold ?? 1.2;
  if (input.allocatedCents <= 0) return null;
  const ratio = input.spentCents / input.allocatedCents;
  if (ratio < threshold) return null;

  return signal({
    id: `child_overflow_${input.childId}`,
    severity: ratio >= 1.5 ? "critical" : "warning",
    category: "replication",
    title: `Child agent "${input.childName}" exceeded budget`,
    detail:
      `Child ${input.childId} has spent ${input.spentCents}¢ ` +
      `of its ${input.allocatedCents}¢ allocation (${(ratio * 100).toFixed(0)}%). ` +
      `Consider killing the child and investigating what it was doing.`,
    meta: {
      childId: input.childId,
      childName: input.childName,
      allocatedCents: input.allocatedCents,
      spentCents: input.spentCents,
      ratio,
      threshold,
    },
  });
}

// ─── 5. Stuck-in-running alarm ────────────────────────────────────────
//
// Fires when the agent is in the "running" state but has not completed
// a turn in >10 minutes AND has no inference request in flight. This
// catches agents that are alive but not making progress:
//   - Infinite loops that the circuit breaker didn't catch
//   - Deadlocks in state locks (C11/C12 TOCTOU retries)
//   - Sleep_until timestamps that never expire
//
// The `inferenceStartedAt` field is critical — without it, a legitimate
// long-running inference call (200k-context compression) would look
// identical to a stuck loop. Must be a TIMESTAMP not a boolean, so we
// can also detect "inference has been in flight for >30 minutes"
// (a separate stuck mode).
//
// TODO(audit-followup): expose `inference_started_at` (ISO string | null)
//   in the agent status endpoint. The inference client must set it
//   before calling the provider and clear it in a `finally` block to
//   survive timeouts and errors. See CONTRIBUTING.md "timer trap".
//   Location: automaton-fork/src/inference/router.ts + api/server.ts

export interface StuckInRunningInput {
  state: string;
  /** ms since the last turn completed. */
  msSinceLastTurn: number;
  /** ISO timestamp when current inference started, or null if idle. */
  inferenceStartedAt: string | null;
  /** Threshold in ms for "stuck" (default: 10 min). */
  stuckThresholdMs?: number;
  /** Threshold for "inference hung" (default: 30 min). */
  inferenceHungThresholdMs?: number;
}

export function checkStuckInRunning(
  input: StuckInRunningInput,
): AlarmSignal | null {
  const stuckThreshold = input.stuckThresholdMs ?? 10 * 60_000;
  const inferenceHungThreshold = input.inferenceHungThresholdMs ?? 30 * 60_000;

  // Only applies when agent claims to be "running"
  if (input.state !== "running") return null;

  // Case A: no inference in flight AND no turn progress → stuck in agent loop
  if (input.inferenceStartedAt === null) {
    if (input.msSinceLastTurn < stuckThreshold) return null;

    return signal({
      id: "stuck_in_running",
      severity: "critical",
      category: "liveness",
      title: "Agent is in 'running' state but not making progress",
      detail:
        `Last turn completed ${Math.round(input.msSinceLastTurn / 60_000)} minutes ago. ` +
        `No inference in flight. Circuit breaker may have silently failed, ` +
        `or a state lock is deadlocked. Restart the agent to recover.`,
      meta: {
        state: input.state,
        msSinceLastTurn: input.msSinceLastTurn,
        inferenceStartedAt: null,
      },
    });
  }

  // Case B: inference has been in flight for a very long time → provider hung
  const msSinceInferenceStart =
    Date.now() - new Date(input.inferenceStartedAt).getTime();
  if (msSinceInferenceStart < inferenceHungThreshold) return null;

  return signal({
    id: "inference_hung",
    severity: "critical",
    category: "liveness",
    title: "Inference request has been in flight for too long",
    detail:
      `Inference started at ${input.inferenceStartedAt}, ` +
      `${Math.round(msSinceInferenceStart / 60_000)} minutes ago. ` +
      `Provider may have hung or the request was never cleared in a finally block. ` +
      `Check the inference client's try/finally cleanup (see CONTRIBUTING.md).`,
    meta: {
      state: input.state,
      inferenceStartedAt: input.inferenceStartedAt,
      msSinceInferenceStart,
    },
  });
}
