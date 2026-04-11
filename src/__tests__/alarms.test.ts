/**
 * Detection alarm tests — validates the 5 watchdog functions that turn
 * silent failures into operator-visible signals.
 *
 * Test strategy: each alarm is a pure function from input to
 * AlarmSignal | null. We test:
 *   (a) The condition that fires the alarm
 *   (b) The condition that does NOT fire (just below threshold)
 *   (c) The severity escalation where applicable
 *   (d) Metadata contents (for the operator-readable dashboard)
 *
 * See: automaton-fork/src/observability/alarms.ts
 */

import { describe, it, expect } from "vitest";
import {
  checkSpendAlarm,
  checkDuplicateRevenue,
  checkAuthorityBreach,
  checkChildOverflow,
  checkStuckInRunning,
} from "../observability/alarms.js";

// ─── 1. Spend alarm ───────────────────────────────────────────────────

describe("checkSpendAlarm", () => {
  it("returns null when current hour is below 3x baseline", () => {
    const result = checkSpendAlarm({
      currentHourCents: 150,
      baselineCentsPerHour: 100,
    });
    expect(result).toBeNull();
  });

  it("fires warning when current hour is exactly 3x baseline", () => {
    const result = checkSpendAlarm({
      currentHourCents: 300,
      baselineCentsPerHour: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
    expect(result!.category).toBe("spend");
    expect(result!.id).toBe("spend_anomaly");
  });

  it("escalates to critical when current hour is 6x+ baseline", () => {
    const result = checkSpendAlarm({
      currentHourCents: 700,
      baselineCentsPerHour: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
  });

  it("does not fire when current hour is below the minimum trigger floor", () => {
    // 40c is below the default 50c floor — do not fire even if ratio is 4x
    const result = checkSpendAlarm({
      currentHourCents: 40,
      baselineCentsPerHour: 10,
    });
    expect(result).toBeNull();
  });

  it("does not fire when baseline is zero (first hour, no history)", () => {
    const result = checkSpendAlarm({
      currentHourCents: 1000,
      baselineCentsPerHour: 0,
    });
    expect(result).toBeNull();
  });

  it("respects custom multiplier", () => {
    // 2x multiplier should fire at 2x
    const result = checkSpendAlarm({
      currentHourCents: 200,
      baselineCentsPerHour: 100,
      multiplier: 2,
    });
    expect(result).not.toBeNull();
  });

  it("includes ratio and raw values in metadata", () => {
    const result = checkSpendAlarm({
      currentHourCents: 450,
      baselineCentsPerHour: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.meta).toMatchObject({
      currentHourCents: 450,
      baselineCentsPerHour: 100,
      ratio: 4.5,
    });
  });
});

// ─── 2. Duplicate revenue alarm ───────────────────────────────────────

describe("checkDuplicateRevenue", () => {
  it("returns null for a single occurrence (happy path)", () => {
    const result = checkDuplicateRevenue({
      chargeId: "ch_xyz",
      occurrenceCount: 1,
      windowMinutes: 5,
    });
    expect(result).toBeNull();
  });

  it("fires critical when the same chargeId appears twice", () => {
    const result = checkDuplicateRevenue({
      chargeId: "ch_xyz",
      occurrenceCount: 2,
      windowMinutes: 5,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.category).toBe("revenue");
    expect(result!.id).toContain("ch_xyz");
  });

  it("includes charge id + count + window in metadata", () => {
    const result = checkDuplicateRevenue({
      chargeId: "ch_abc",
      occurrenceCount: 3,
      windowMinutes: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.meta).toMatchObject({
      chargeId: "ch_abc",
      occurrenceCount: 3,
      windowMinutes: 10,
    });
  });
});

// ─── 3. Authority breach alarm ────────────────────────────────────────

describe("checkAuthorityBreach", () => {
  it("always fires (function is called only on confirmed rejection)", () => {
    const result = checkAuthorityBreach({
      action: "update-governance-config",
      fieldAttempted: "enforcementMode",
      attemptedValue: "soft_warning",
      currentValue: "approval_gate",
      actor: undefined,
      companyId: "co-1",
    });
    expect(result.severity).toBe("critical");
    expect(result.category).toBe("authority");
  });

  it("does not leak secret-shaped actor objects into meta", () => {
    // If a malicious caller passes a Proxy or secret-like object as
    // actor, the alarm must record the TYPE, not the value itself.
    const secretLike = { apiKey: "sk-super-secret" };
    const result = checkAuthorityBreach({
      action: "update-governance-config",
      fieldAttempted: "enforcementMode",
      attemptedValue: "soft_warning",
      currentValue: "approval_gate",
      actor: secretLike,
      companyId: "co-1",
    });

    // The alarm must NOT contain the secret value verbatim
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-super-secret");
    // It SHOULD record the type for debugging
    expect(result.meta).toMatchObject({ actorType: "object" });
  });

  it("includes company id and action in the alarm id for deduplication", () => {
    const result = checkAuthorityBreach({
      action: "update-governance-config",
      fieldAttempted: "enforcementMode",
      attemptedValue: "soft_warning",
      currentValue: "approval_gate",
      actor: "admin",
      companyId: "co-42",
    });
    expect(result.id).toContain("update-governance-config");
    expect(result.id).toContain("co-42");
  });
});

// ─── 4. Child credit overflow alarm ───────────────────────────────────

describe("checkChildOverflow", () => {
  it("returns null when child is under allocation", () => {
    const result = checkChildOverflow({
      childId: "c-1",
      childName: "marketing-child",
      allocatedCents: 1000,
      spentCents: 500,
    });
    expect(result).toBeNull();
  });

  it("returns null when spent exactly equals allocation", () => {
    const result = checkChildOverflow({
      childId: "c-1",
      childName: "marketing-child",
      allocatedCents: 1000,
      spentCents: 1000,
    });
    expect(result).toBeNull();
  });

  it("fires warning at 120% of allocation (default threshold)", () => {
    const result = checkChildOverflow({
      childId: "c-1",
      childName: "marketing-child",
      allocatedCents: 1000,
      spentCents: 1200,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("warning");
  });

  it("escalates to critical at 150% of allocation", () => {
    const result = checkChildOverflow({
      childId: "c-1",
      childName: "marketing-child",
      allocatedCents: 1000,
      spentCents: 1500,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
  });

  it("does not fire when allocation is zero (uninitialized)", () => {
    const result = checkChildOverflow({
      childId: "c-1",
      childName: "marketing-child",
      allocatedCents: 0,
      spentCents: 100,
    });
    expect(result).toBeNull();
  });

  it("includes child id in alarm id for deduplication", () => {
    const result = checkChildOverflow({
      childId: "c-deploy-42",
      childName: "deploy-child",
      allocatedCents: 1000,
      spentCents: 1300,
    });
    expect(result!.id).toContain("c-deploy-42");
  });
});

// ─── 5. Stuck-in-running alarm ────────────────────────────────────────

describe("checkStuckInRunning", () => {
  it("returns null when state is not 'running'", () => {
    // Sleeping agents are not stuck — they're sleeping.
    const result = checkStuckInRunning({
      state: "sleeping",
      msSinceLastTurn: 20 * 60_000,
      inferenceStartedAt: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when agent is running AND has recent turn progress", () => {
    const result = checkStuckInRunning({
      state: "running",
      msSinceLastTurn: 60_000, // 1 minute — fine
      inferenceStartedAt: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when agent is running with an active inference (long context)", () => {
    // 15 minutes since last turn, but inference started 2 min ago —
    // this is a legitimate long-context call, NOT stuck.
    const now = Date.now();
    const result = checkStuckInRunning({
      state: "running",
      msSinceLastTurn: 15 * 60_000,
      inferenceStartedAt: new Date(now - 2 * 60_000).toISOString(),
    });
    expect(result).toBeNull();
  });

  it("fires critical when running with no inference AND no turn progress for >10 min", () => {
    const result = checkStuckInRunning({
      state: "running",
      msSinceLastTurn: 15 * 60_000,
      inferenceStartedAt: null,
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.id).toBe("stuck_in_running");
  });

  it("fires separate 'inference_hung' alarm when inference has been in flight for >30 min", () => {
    const now = Date.now();
    const result = checkStuckInRunning({
      state: "running",
      msSinceLastTurn: 45 * 60_000,
      inferenceStartedAt: new Date(now - 35 * 60_000).toISOString(),
    });
    expect(result).not.toBeNull();
    // Different id so the operator can distinguish the two modes
    expect(result!.id).toBe("inference_hung");
    expect(result!.severity).toBe("critical");
  });

  it("does NOT fire inference_hung when inference is recent (<30 min)", () => {
    const now = Date.now();
    const result = checkStuckInRunning({
      state: "running",
      msSinceLastTurn: 45 * 60_000, // this would have triggered stuck_in_running
      inferenceStartedAt: new Date(now - 5 * 60_000).toISOString(), // but inference is active
    });
    expect(result).toBeNull();
  });

  it("respects custom stuckThresholdMs", () => {
    // Tighter threshold — fire at 2 minutes instead of 10
    const result = checkStuckInRunning({
      state: "running",
      msSinceLastTurn: 3 * 60_000,
      inferenceStartedAt: null,
      stuckThresholdMs: 2 * 60_000,
    });
    expect(result).not.toBeNull();
  });
});
