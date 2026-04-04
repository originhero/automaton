/**
 * Task Types Tests
 *
 * TDD tests for parseTaskInput, serializeTaskOutput, and serializeTurn.
 */

import { describe, it, expect } from "vitest";
import {
  parseTaskInput,
  serializeTaskOutput,
  serializeTurn,
} from "../../cli/task-types.js";
import type {
  TaskInput,
  TaskOutput,
  SerializedTurn,
} from "../../cli/task-types.js";
import type { AgentTurn } from "../../types.js";

// ─── parseTaskInput ────────────────────────────────────────────────

describe("parseTaskInput", () => {
  it("parses a valid minimal input", () => {
    const raw = JSON.stringify({
      runId: "run-001",
      agentId: "agent-abc",
      companyId: "company-xyz",
      prompt: "Do the thing",
      session: null,
      config: {},
    });

    const result = parseTaskInput(raw);

    expect(result.runId).toBe("run-001");
    expect(result.agentId).toBe("agent-abc");
    expect(result.companyId).toBe("company-xyz");
    expect(result.prompt).toBe("Do the thing");
    expect(result.session).toBeNull();
    expect(result.config).toEqual({});
  });

  it("parses input with session state", () => {
    const raw = JSON.stringify({
      runId: "run-002",
      agentId: "agent-abc",
      companyId: "company-xyz",
      prompt: "Continue the task",
      context: "Some extra context",
      session: {
        turns: [
          {
            id: "turn-1",
            thinking: "I should run exec",
            toolCalls: [
              {
                name: "exec",
                args: { command: "ls" },
                result: "file.txt",
              },
            ],
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 50,
              cachedInputTokens: 10,
            },
            costCents: 5,
          },
        ],
        kvState: { foo: "bar" },
        workdir: "/tmp/workspace",
      },
      config: {
        genesisPrompt: "You are an agent",
        inferenceModel: "claude-3-opus",
        maxTurnsPerCycle: 10,
        skills: ["exec", "read"],
      },
    });

    const result = parseTaskInput(raw);

    expect(result.runId).toBe("run-002");
    expect(result.context).toBe("Some extra context");
    expect(result.session).not.toBeNull();
    expect(result.session!.turns).toHaveLength(1);
    expect(result.session!.turns[0].id).toBe("turn-1");
    expect(result.session!.turns[0].toolCalls[0].name).toBe("exec");
    expect(result.session!.kvState).toEqual({ foo: "bar" });
    expect(result.session!.workdir).toBe("/tmp/workspace");
    expect(result.config.genesisPrompt).toBe("You are an agent");
    expect(result.config.inferenceModel).toBe("claude-3-opus");
    expect(result.config.maxTurnsPerCycle).toBe(10);
    expect(result.config.skills).toEqual(["exec", "read"]);
  });

  it("throws when runId is missing", () => {
    const raw = JSON.stringify({
      agentId: "agent-abc",
      companyId: "company-xyz",
      prompt: "Do the thing",
      session: null,
      config: {},
    });
    expect(() => parseTaskInput(raw)).toThrow(/runId/);
  });

  it("throws when agentId is missing", () => {
    const raw = JSON.stringify({
      runId: "run-001",
      companyId: "company-xyz",
      prompt: "Do the thing",
      session: null,
      config: {},
    });
    expect(() => parseTaskInput(raw)).toThrow(/agentId/);
  });

  it("throws when companyId is missing", () => {
    const raw = JSON.stringify({
      runId: "run-001",
      agentId: "agent-abc",
      prompt: "Do the thing",
      session: null,
      config: {},
    });
    expect(() => parseTaskInput(raw)).toThrow(/companyId/);
  });

  it("throws when prompt is missing", () => {
    const raw = JSON.stringify({
      runId: "run-001",
      agentId: "agent-abc",
      companyId: "company-xyz",
      session: null,
      config: {},
    });
    expect(() => parseTaskInput(raw)).toThrow(/prompt/);
  });

  it("throws when session field is absent (not null)", () => {
    const raw = JSON.stringify({
      runId: "run-001",
      agentId: "agent-abc",
      companyId: "company-xyz",
      prompt: "Do the thing",
      config: {},
    });
    expect(() => parseTaskInput(raw)).toThrow(/session/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTaskInput("not-json")).toThrow();
  });
});

// ─── serializeTaskOutput ──────────────────────────────────────────

describe("serializeTaskOutput", () => {
  const sampleOutput: TaskOutput = {
    success: true,
    exitReason: "completed",
    summary: "Task completed successfully",
    turns: [],
    totalUsage: { inputTokens: 200, outputTokens: 100 },
    totalCostCents: 15,
    model: "claude-3-opus",
    provider: "anthropic",
    session: {
      turns: [],
      kvState: {},
      workdir: null,
    },
    survivalTier: "normal",
    creditBalance: 9985,
  };

  it("serializes to valid JSON string", () => {
    const result = serializeTaskOutput(sampleOutput);
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
  });

  it("round-trips correctly", () => {
    const result = serializeTaskOutput(sampleOutput);
    const parsed = JSON.parse(result) as TaskOutput;

    expect(parsed.success).toBe(sampleOutput.success);
    expect(parsed.exitReason).toBe(sampleOutput.exitReason);
    expect(parsed.summary).toBe(sampleOutput.summary);
    expect(parsed.totalCostCents).toBe(sampleOutput.totalCostCents);
    expect(parsed.model).toBe(sampleOutput.model);
    expect(parsed.provider).toBe(sampleOutput.provider);
    expect(parsed.survivalTier).toBe(sampleOutput.survivalTier);
    expect(parsed.creditBalance).toBe(sampleOutput.creditBalance);
    expect(parsed.totalUsage).toEqual(sampleOutput.totalUsage);
    expect(parsed.session).toEqual(sampleOutput.session);
  });

  it("serializes turns inside session", () => {
    const outputWithTurns: TaskOutput = {
      ...sampleOutput,
      session: {
        turns: [
          {
            id: "turn-1",
            thinking: "thinking about it",
            toolCalls: [],
            tokenUsage: { inputTokens: 50, outputTokens: 25 },
            costCents: 3,
          },
        ],
        kvState: { key: "value" },
        workdir: "/workspace",
      },
    };
    const result = serializeTaskOutput(outputWithTurns);
    const parsed = JSON.parse(result) as TaskOutput;
    expect(parsed.session.turns).toHaveLength(1);
    expect(parsed.session.turns[0].id).toBe("turn-1");
    expect(parsed.session.kvState).toEqual({ key: "value" });
    expect(parsed.session.workdir).toBe("/workspace");
  });
});

// ─── serializeTurn ────────────────────────────────────────────────

describe("serializeTurn", () => {
  const agentTurn: AgentTurn = {
    id: "turn-abc",
    timestamp: "2024-01-01T00:00:00.000Z",
    state: "running",
    input: "Do something",
    inputSource: "creator",
    thinking: "I will run exec",
    toolCalls: [
      {
        id: "call-1",
        name: "exec",
        arguments: { command: "ls -la" },
        result: "total 42\ndrwxr-xr-x ...",
        durationMs: 120,
      },
      {
        id: "call-2",
        name: "read",
        arguments: { path: "/tmp/file.txt" },
        result: "file contents",
        durationMs: 5,
        error: undefined,
      },
    ],
    tokenUsage: {
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
    },
    costCents: 12,
  };

  it("maps AgentTurn to SerializedTurn correctly", () => {
    const result: SerializedTurn = serializeTurn(agentTurn);

    expect(result.id).toBe("turn-abc");
    expect(result.thinking).toBe("I will run exec");
    expect(result.costCents).toBe(12);
  });

  it("maps tokenUsage from promptTokens/completionTokens to inputTokens/outputTokens", () => {
    const result = serializeTurn(agentTurn);
    expect(result.tokenUsage.inputTokens).toBe(200);
    expect(result.tokenUsage.outputTokens).toBe(80);
  });

  it("maps toolCalls to {name, args, result}", () => {
    const result = serializeTurn(agentTurn);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe("exec");
    expect(result.toolCalls[0].args).toEqual({ command: "ls -la" });
    expect(result.toolCalls[0].result).toBe("total 42\ndrwxr-xr-x ...");
    expect(result.toolCalls[1].name).toBe("read");
  });

  it("does not include extra AgentTurn fields (id, timestamp, state) in toolCalls", () => {
    const result = serializeTurn(agentTurn);
    const call = result.toolCalls[0] as Record<string, unknown>;
    expect(call["id"]).toBeUndefined();
    expect(call["durationMs"]).toBeUndefined();
  });
});
