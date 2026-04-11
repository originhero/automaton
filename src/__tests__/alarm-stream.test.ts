/**
 * AlarmStream infrastructure tests.
 *
 * Verifies the three sinks: logger-backed, memory-backed, and composite.
 * The logger sink uses `StructuredLogger.setSink` to redirect writes
 * into a test capture buffer — no stdout noise during tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createLoggerAlarmStream,
  createMemoryAlarmStream,
  createCompositeAlarmStream,
} from "../observability/alarm-stream.js";
import { StructuredLogger } from "../observability/logger.js";
import { checkSpendAlarm, checkAuthorityBreach } from "../observability/alarms.js";
import type { LogEntry } from "../types.js";

describe("createMemoryAlarmStream", () => {
  it("stores emitted alarms in insertion order", () => {
    const stream = createMemoryAlarmStream();

    const alarm1 = checkSpendAlarm({
      currentHourCents: 400,
      baselineCentsPerHour: 100,
    });
    const alarm2 = checkAuthorityBreach({
      action: "update-governance-config",
      fieldAttempted: "enforcementMode",
      attemptedValue: "soft_warning",
      currentValue: "approval_gate",
      actor: "rogue-agent",
      companyId: "co-1",
    });

    expect(alarm1).not.toBeNull();
    stream.emit(alarm1!);
    stream.emit(alarm2);

    expect(stream.count()).toBe(2);
    const all = stream.getAll();
    expect(all[0]).toEqual(alarm1);
    expect(all[1]).toEqual(alarm2);
  });

  it("clear() empties the buffer", () => {
    const stream = createMemoryAlarmStream();
    stream.emit(checkAuthorityBreach({
      action: "x",
      fieldAttempted: "y",
      attemptedValue: "z",
      currentValue: "w",
      actor: null,
      companyId: "co-1",
    }));
    expect(stream.count()).toBe(1);
    stream.clear();
    expect(stream.count()).toBe(0);
    expect(stream.getAll()).toEqual([]);
  });

  it("findById locates an alarm by its id", () => {
    const stream = createMemoryAlarmStream();
    const alarm = checkSpendAlarm({
      currentHourCents: 400,
      baselineCentsPerHour: 100,
    });
    stream.emit(alarm!);

    expect(stream.findById("spend_anomaly")).toEqual(alarm);
    expect(stream.findById("nonexistent")).toBeUndefined();
  });

  it("findByCategory filters alarms by category", () => {
    const stream = createMemoryAlarmStream();
    const spendAlarm = checkSpendAlarm({
      currentHourCents: 400,
      baselineCentsPerHour: 100,
    });
    const authAlarm = checkAuthorityBreach({
      action: "x",
      fieldAttempted: "y",
      attemptedValue: "z",
      currentValue: "w",
      actor: "admin",
      companyId: "co-1",
    });
    stream.emit(spendAlarm!);
    stream.emit(authAlarm);

    expect(stream.findByCategory("spend")).toEqual([spendAlarm]);
    expect(stream.findByCategory("authority")).toEqual([authAlarm]);
    expect(stream.findByCategory("revenue")).toEqual([]);
  });
});

describe("createLoggerAlarmStream", () => {
  const capturedLogs: LogEntry[] = [];

  beforeEach(() => {
    capturedLogs.length = 0;
    StructuredLogger.setSink((entry) => {
      capturedLogs.push(entry);
    });
  });

  afterEach(() => {
    StructuredLogger.resetSink();
  });

  it("routes critical alarms to logger.error", () => {
    const stream = createLoggerAlarmStream("test-alarms");
    const alarm = checkAuthorityBreach({
      action: "update-governance-config",
      fieldAttempted: "enforcementMode",
      attemptedValue: "soft_warning",
      currentValue: "approval_gate",
      actor: "rogue-agent",
      companyId: "co-1",
    });

    stream.emit(alarm);

    expect(capturedLogs.length).toBeGreaterThan(0);
    const entry = capturedLogs[capturedLogs.length - 1];
    expect(entry.level).toBe("error");
    expect(entry.module).toBe("test-alarms");
    expect(entry.message).toContain("[ALARM:authority]");
    expect(entry.context).toMatchObject({
      alarm_id: expect.stringContaining("authority_breach"),
      severity: "critical",
      category: "authority",
    });
  });

  it("routes warning alarms to logger.warn", () => {
    const stream = createLoggerAlarmStream("test-alarms");
    // 3x multiplier fires as warning (not critical)
    const alarm = checkSpendAlarm({
      currentHourCents: 300,
      baselineCentsPerHour: 100,
    });
    expect(alarm).not.toBeNull();

    stream.emit(alarm!);

    const entry = capturedLogs[capturedLogs.length - 1];
    expect(entry.level).toBe("warn");
    expect(entry.message).toContain("[ALARM:spend]");
    expect(entry.context).toMatchObject({
      severity: "warning",
    });
  });

  it("includes alarm meta as structured log context", () => {
    const stream = createLoggerAlarmStream("test-alarms");
    const alarm = checkSpendAlarm({
      currentHourCents: 450,
      baselineCentsPerHour: 100,
    });

    stream.emit(alarm!);

    const entry = capturedLogs[capturedLogs.length - 1];
    // Meta fields from checkSpendAlarm should be hoisted into context
    expect(entry.context).toMatchObject({
      currentHourCents: 450,
      baselineCentsPerHour: 100,
      ratio: 4.5,
    });
    expect(entry.context).toMatchObject({
      fired_at: expect.any(String),
      detail: expect.any(String),
    });
  });
});

describe("createCompositeAlarmStream", () => {
  it("emits the same alarm to all sinks", () => {
    const memory1 = createMemoryAlarmStream();
    const memory2 = createMemoryAlarmStream();
    const composite = createCompositeAlarmStream(memory1, memory2);

    const alarm = checkSpendAlarm({
      currentHourCents: 400,
      baselineCentsPerHour: 100,
    });
    composite.emit(alarm!);

    expect(memory1.count()).toBe(1);
    expect(memory2.count()).toBe(1);
  });

  it("continues emitting when one sink throws", () => {
    const memory = createMemoryAlarmStream();
    const broken: { emit: (alarm: any) => never } = {
      emit: () => {
        throw new Error("sink failure");
      },
    };
    const composite = createCompositeAlarmStream(broken, memory);

    const alarm = checkSpendAlarm({
      currentHourCents: 400,
      baselineCentsPerHour: 100,
    });

    // Must not throw — the second sink still receives the alarm
    expect(() => composite.emit(alarm!)).not.toThrow();
    expect(memory.count()).toBe(1);
  });
});
