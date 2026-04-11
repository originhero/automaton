/**
 * AlarmStream — the sink that detection alarms emit into.
 *
 * `alarms.ts` defines pure `check*` functions that return
 * `AlarmSignal | null`. Those functions are tested in isolation
 * (see `__tests__/alarms.test.ts`). This module provides the
 * production sinks that actually deliver the signal to the operator.
 *
 * Philosophy: the sink is deliberately minimal. Structured logs +
 * a bounded in-memory ring buffer is enough for single-node operation.
 * A real dashboard / paging integration can consume the structured
 * log stream (Loki, Papertrail, journalctl) without any code change
 * in the alarm call sites.
 *
 * Two implementations:
 *   - `createLoggerAlarmStream()` — production default. Writes to the
 *     structured logger with severity-mapped log levels. Visible in
 *     any log aggregator that reads stdout/stderr.
 *   - `createMemoryAlarmStream()` — test-time. Stores emitted alarms
 *     in memory so tests can assert on them.
 *
 * Both implementations share the `AlarmStream` interface, so a call
 * site can swap sinks without code changes.
 */

import { createLogger } from "./logger.js";
import type { AlarmSignal } from "./alarms.js";

export interface AlarmStream {
  emit(alarm: AlarmSignal): void;
}

/**
 * Production sink: routes alarms to the structured logger with
 * severity mapping. The log line format is a prefix
 * `[ALARM:{category}] {title}` followed by the full metadata as
 * structured fields — searchable by log aggregator.
 *
 * Severity → log level:
 *   critical → logger.error
 *   warning  → logger.warn
 *   info     → logger.info
 */
export function createLoggerAlarmStream(
  loggerName: string = "alarms",
): AlarmStream {
  const logger = createLogger(loggerName);
  return {
    emit(alarm: AlarmSignal): void {
      const message = `[ALARM:${alarm.category}] ${alarm.title}`;
      const context = {
        alarm_id: alarm.id,
        severity: alarm.severity,
        category: alarm.category,
        detail: alarm.detail,
        fired_at: alarm.firedAt,
        ...(alarm.meta ?? {}),
      };

      // StructuredLogger signature:
      //   error(message, error?, context?)
      //   warn/info(message, context?)
      if (alarm.severity === "critical") {
        logger.error(message, undefined, context);
      } else if (alarm.severity === "warning") {
        logger.warn(message, context);
      } else {
        logger.info(message, context);
      }
    },
  };
}

/**
 * Test sink: stores emitted alarms in memory so tests can assert
 * on them. Has an extra `getAll()` method not part of the
 * `AlarmStream` interface — use it from test code only.
 */
export interface MemoryAlarmStream extends AlarmStream {
  getAll(): AlarmSignal[];
  clear(): void;
  count(): number;
  findById(id: string): AlarmSignal | undefined;
  findByCategory(category: AlarmSignal["category"]): AlarmSignal[];
}

export function createMemoryAlarmStream(): MemoryAlarmStream {
  const alarms: AlarmSignal[] = [];
  return {
    emit(alarm: AlarmSignal): void {
      alarms.push(alarm);
    },
    getAll(): AlarmSignal[] {
      return [...alarms];
    },
    clear(): void {
      alarms.length = 0;
    },
    count(): number {
      return alarms.length;
    },
    findById(id: string): AlarmSignal | undefined {
      return alarms.find((a) => a.id === id);
    },
    findByCategory(category: AlarmSignal["category"]): AlarmSignal[] {
      return alarms.filter((a) => a.category === category);
    },
  };
}

/**
 * Composite sink: emits to multiple sinks simultaneously.
 * Useful when you want both production logging AND in-memory capture
 * during tests, or when integrating a dashboard sink alongside the
 * logger sink.
 */
export function createCompositeAlarmStream(
  ...sinks: AlarmStream[]
): AlarmStream {
  return {
    emit(alarm: AlarmSignal): void {
      for (const sink of sinks) {
        try {
          sink.emit(alarm);
        } catch (err) {
          // One sink failing must not prevent the others from receiving
          // the alarm. Swallow errors but log to stderr as a last resort.
          console.error(
            `[alarm-stream] sink failed to emit alarm ${alarm.id}: ${String(err)}`,
          );
        }
      }
    },
  };
}
