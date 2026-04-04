/**
 * Task Runner Tests
 *
 * Tests for the pure helper functions aggregateUsage and mapExitReason.
 * The main runTask function is tested indirectly via these helpers;
 * full integration testing requires a mock runAgentLoop dependency.
 */

import { describe, it, expect } from "vitest";
import { aggregateUsage, mapExitReason } from "../../cli/task-runner.js";

describe("aggregateUsage", () => {
  it("sums usage across multiple turns", () => {
    const turns = [
      {
        id: "t1",
        thinking: "...",
        toolCalls: [],
        tokenUsage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
        costCents: 2,
      },
      {
        id: "t2",
        thinking: "...",
        toolCalls: [],
        tokenUsage: { inputTokens: 200, outputTokens: 80 },
        costCents: 3,
      },
    ];
    const result = aggregateUsage(turns);
    expect(result.totalUsage.inputTokens).toBe(300);
    expect(result.totalUsage.outputTokens).toBe(130);
    expect(result.totalUsage.cachedInputTokens).toBe(10);
    expect(result.totalCostCents).toBe(5);
  });

  it("returns zeros for empty turns", () => {
    const result = aggregateUsage([]);
    expect(result.totalUsage.inputTokens).toBe(0);
    expect(result.totalUsage.outputTokens).toBe(0);
    expect(result.totalUsage.cachedInputTokens).toBe(0);
    expect(result.totalCostCents).toBe(0);
  });

  it("handles turns with no cachedInputTokens", () => {
    const turns = [
      {
        id: "t1",
        thinking: "...",
        toolCalls: [],
        tokenUsage: { inputTokens: 50, outputTokens: 20 },
        costCents: 1,
      },
    ];
    const result = aggregateUsage(turns);
    expect(result.totalUsage.inputTokens).toBe(50);
    expect(result.totalUsage.outputTokens).toBe(20);
    expect(result.totalUsage.cachedInputTokens).toBe(0);
  });

  it("handles single turn correctly", () => {
    const turns = [
      {
        id: "t1",
        thinking: "thinking",
        toolCalls: [],
        tokenUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 },
        costCents: 7,
      },
    ];
    const result = aggregateUsage(turns);
    expect(result.totalUsage.inputTokens).toBe(10);
    expect(result.totalUsage.outputTokens).toBe(5);
    expect(result.totalUsage.cachedInputTokens).toBe(3);
    expect(result.totalCostCents).toBe(7);
  });
});

describe("mapExitReason", () => {
  it("maps sleeping state", () => {
    expect(mapExitReason("sleeping", false, 5, 25)).toBe("sleeping");
  });

  it("maps timeout", () => {
    expect(mapExitReason("running", true, 5, 25)).toBe("timeout");
  });

  it("maps max turns", () => {
    expect(mapExitReason("running", false, 25, 25)).toBe("max_turns");
  });

  it("maps normal completion", () => {
    expect(mapExitReason("running", false, 5, 25)).toBe("completed");
  });

  it("prioritizes sleeping over timeout check", () => {
    // sleeping state should win even if timedOut is true
    expect(mapExitReason("sleeping", true, 5, 25)).toBe("sleeping");
  });

  it("prioritizes timeout over max_turns check", () => {
    // timed out and at max turns — timeout wins
    expect(mapExitReason("running", true, 25, 25)).toBe("timeout");
  });

  it("maps dead state as sleeping (agent completed lifecycle)", () => {
    // dead is a valid terminal state — maps to sleeping
    expect(mapExitReason("dead", false, 5, 25)).toBe("sleeping");
  });
});
