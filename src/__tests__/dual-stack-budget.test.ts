/**
 * Day 3 — Class B regression test for bug C2 (dual inference stack).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * THIS TEST IS CURRENTLY EXPECTED TO FAIL.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * Bug C2: there are TWO parallel inference stacks:
 *   1. `InferenceRouter` (src/inference/router.ts) — used by the agent
 *      loop. Calls `budget.recordCost()` for every inference call.
 *   2. `UnifiedInferenceClient` (src/inference/inference-client.ts) —
 *      used by the compression pipeline. Does NOT call `recordCost`.
 *
 * The result: compression calls (which can be very large — tens of
 * thousands of tokens) bypass the budget tracker entirely. An agent
 * that triggers heavy compression can silently spend the weekly budget
 * without a single alarm firing.
 *
 * This test codifies the contract: **every file that performs a chat
 * completion must call `budget.recordCost()`** (or route through a
 * file that does). The test uses static code analysis — it reads the
 * source files and greps for the anti-pattern.
 *
 * Why static analysis instead of a runtime mock test:
 *   - The anti-pattern is structural: `inference-client.ts` does not
 *     import BudgetTracker at all. A runtime mock test would require
 *     booting both stacks and asserting that mock.recordCost was
 *     called — more fragile and less direct than reading the file.
 *   - Static analysis catches the bug even if the consolidation is
 *     partially done (e.g. one code path still bypasses).
 *
 * When will this test pass:
 *   - When `inference-client.ts` either (a) imports and calls
 *     `BudgetTracker.recordCost` directly, or (b) is deleted and its
 *     callers migrate to `InferenceRouter`. Either is a valid fix for C2.
 *
 * Related:
 *   - `docs/AUDIT-REPORT.md` bug C2 (dual inference stack)
 *   - `docs/BACKLOG.md` P0: "C2 — Dual inference stack"
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the src/inference directory relative to this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INFERENCE_DIR = join(__dirname, "..", "inference");

/**
 * Read a source file and return its content, or throw a clear error
 * if the file has moved.
 */
function readSource(relativePath: string): string {
  const fullPath = join(INFERENCE_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(
      `Source file not found at ${fullPath}. ` +
        `If the file was moved or renamed, update this test to point to ` +
        `the new location — but DO NOT remove the test without verifying ` +
        `that C2 has been fixed. See docs/BACKLOG.md for the fix contract.`,
    );
  }
  return readFileSync(fullPath, "utf-8");
}

describe("Class B — C2 dual inference stack (budget bypass)", () => {
  /**
   * The known-good side of the contract: `router.ts` DOES call
   * `budget.recordCost()`. This is a sanity check — if this fails,
   * someone removed the cost tracking from the router entirely and
   * the bug has gotten WORSE, not better.
   */
  it("router.ts calls budget.recordCost() (sanity check of the good side)", () => {
    const source = readSource("router.ts");
    expect(source).toMatch(/\.recordCost\(/);
  });

  /**
   * The bug side: `inference-client.ts` does NOT currently call
   * `recordCost`. This test marks the expectation as `.fails()` so
   * that when the consolidation happens and inference-client.ts starts
   * calling recordCost (or is deleted), the test will start passing
   * and vitest will flag the `.fails()` wrapper as stale.
   *
   * At that point, the human remediating the test should:
   *   1. Verify that C2 is actually fixed (not that the file was just
   *      renamed or the grep pattern was changed).
   *   2. Remove `.fails(` from below.
   *   3. Update `docs/BACKLOG.md` to mark C2 as resolved.
   */
  it.fails(
    "inference-client.ts calls budget.recordCost() (BLOCKED: C2 consolidation pending)",
    () => {
      const source = readSource("inference-client.ts");
      // The weakest assertion we can make that still proves the bug is
      // fixed: the file must at least MENTION recordCost or BudgetTracker.
      // We don't enforce HOW it's called — just that the stack is aware
      // of the budget tracker at all.
      const hasRecordCost = /\.recordCost\(/.test(source);
      const hasBudgetImport = /BudgetTracker|budget\.ts/.test(source);
      expect(hasRecordCost || hasBudgetImport).toBe(true);
    },
  );

  /**
   * Companion property: the compression pipeline (which is what
   * actually uses UnifiedInferenceClient) must have SOME path to
   * budget tracking. When C2 is fixed, compression should either:
   *   - Use the same InferenceRouter as the agent loop, OR
   *   - Record costs via a separate but visible mechanism
   *
   * This test scans `memory/compression-engine.ts` for the connection.
   * It's also expected to fail today.
   */
  it.fails(
    "compression-engine.ts has a budget tracking path (BLOCKED: C2 consolidation pending)",
    () => {
      const compressionPath = join(
        __dirname,
        "..",
        "memory",
        "compression-engine.ts",
      );
      if (!existsSync(compressionPath)) {
        // If the file moved, the test can't run — skip without failing
        // the broader suite. But mark this clearly so the reviewer
        // notices on next audit.
        throw new Error(
          `compression-engine.ts not found at ${compressionPath}. ` +
            `Update the path in this test or verify the compression pipeline still exists.`,
        );
      }
      const source = readFileSync(compressionPath, "utf-8");
      const hasRecordCost = /\.recordCost\(|BudgetTracker/.test(source);
      expect(hasRecordCost).toBe(true);
    },
  );
});
