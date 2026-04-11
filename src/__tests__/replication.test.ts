/**
 * Tests for Sub-phase 0.6: Replication Safety
 *
 * Validates wallet address checking, spawn cleanup on failure,
 * and prevention of funding to zero-address wallets.
 *
 * Updated for Phase 3.1: spawnChild now uses ConwayClient interface
 * directly instead of raw fetch-based execInSandbox/writeInSandbox.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isValidWalletAddress, spawnChild } from "../replication/spawn.js";
import { SandboxCleanup } from "../replication/cleanup.js";
import { ChildLifecycle } from "../replication/lifecycle.js";
import { pruneDeadChildren } from "../replication/lineage.js";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type { AutomatonDatabase, GenesisConfig } from "../types.js";
import { MIGRATION_V7 } from "../state/schema.js";

// Mock fs for constitution propagation
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => { throw new Error("file not found"); }),
      existsSync: actual.existsSync,
      mkdirSync: actual.mkdirSync,
      mkdtempSync: actual.mkdtempSync,
    },
    readFileSync: vi.fn(() => { throw new Error("file not found"); }),
    existsSync: actual.existsSync,
    mkdirSync: actual.mkdirSync,
    mkdtempSync: actual.mkdtempSync,
  };
});

// ─── isValidWalletAddress ─────────────────────────────────────

describe("isValidWalletAddress", () => {
  it("accepts a valid 40-hex-char address with 0x prefix", () => {
    expect(isValidWalletAddress("0xabcdef1234567890abcdef1234567890abcdef12")).toBe(true);
  });

  it("accepts uppercase hex characters", () => {
    expect(isValidWalletAddress("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(true);
  });

  it("accepts mixed-case hex characters", () => {
    expect(isValidWalletAddress("0xAbCdEf1234567890aBcDeF1234567890AbCdEf12")).toBe(true);
  });

  it("rejects the zero address", () => {
    expect(isValidWalletAddress("0x" + "0".repeat(40))).toBe(false);
  });

  it("rejects addresses without 0x prefix", () => {
    expect(isValidWalletAddress("abcdef1234567890abcdef1234567890abcdef12")).toBe(false);
  });

  it("rejects addresses that are too short", () => {
    expect(isValidWalletAddress("0xabcdef")).toBe(false);
  });

  it("rejects addresses that are too long", () => {
    expect(isValidWalletAddress("0x" + "a".repeat(42))).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidWalletAddress("")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidWalletAddress("0xGGGGGG1234567890abcdef1234567890abcdef12")).toBe(false);
  });

  it("rejects 0x prefix alone", () => {
    expect(isValidWalletAddress("0x")).toBe(false);
  });
});

// ─── spawnChild ───────────────────────────────────────────────

describe("spawnChild", () => {
  let conway: MockConwayClient;
  let db: AutomatonDatabase;
  const identity = createTestIdentity();
  const genesis: GenesisConfig = {
    name: "test-child",
    genesisPrompt: "You are a test child automaton.",
    creatorMessage: "Hello child!",
    creatorAddress: identity.address,
    parentAddress: identity.address,
  };

  const validAddress = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const zeroAddress = "0x" + "0".repeat(40);

  beforeEach(() => {
    conway = new MockConwayClient();
    db = createTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // C10 fix: child --init now emits a structured ORIGINHERO_INIT_RESULT
  // marker instead of the regex-scannable stdout. Tests must mock the new
  // protocol. Plain log lines without the marker MUST throw.
  const initMarker = (address: string, chainType: string = "evm") =>
    `ORIGINHERO_INIT_RESULT=${JSON.stringify({ address, chainType, isNew: true, configDir: "/root/.automaton" })}\n`;

  it("validates wallet address before creating child record", async () => {
    // Mock exec to return valid wallet address on init via the new marker
    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: initMarker(validAddress), stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const child = await spawnChild(conway, identity, db, genesis);

    expect(child.address).toBe(validAddress);
    expect(child.status).toBe("spawning");
  });

  it("throws on zero address from init", async () => {
    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: initMarker(zeroAddress), stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Child wallet address invalid");
  });

  it("throws when init returns no wallet address", async () => {
    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        // No ORIGINHERO_INIT_RESULT marker — must be rejected
        return { stdout: "initialization complete, no wallet", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("ORIGINHERO_INIT_RESULT");
  });

  it("propagates error on exec failure without calling deleteSandbox", async () => {
    const deleteSpy = vi.spyOn(conway, "deleteSandbox");

    // Make the first exec (apt-get install) fail
    vi.spyOn(conway, "exec").mockRejectedValue(new Error("Install failed"));

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow();

    // Sandbox deletion is disabled — should not attempt cleanup
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("propagates error on wallet validation failure without calling deleteSandbox", async () => {
    const deleteSpy = vi.spyOn(conway, "deleteSandbox");

    vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
      if (command.includes("--init")) {
        return { stdout: initMarker(zeroAddress), stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Child wallet address invalid");

    // Sandbox deletion is disabled — should not attempt cleanup
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("does not mask original error if deleteSandbox also throws", async () => {
    vi.spyOn(conway, "deleteSandbox").mockRejectedValue(new Error("delete also failed"));

    // Make exec fail
    vi.spyOn(conway, "exec").mockRejectedValue(new Error("Install failed"));

    // Original error should propagate, not the deleteSandbox error
    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow(/Install failed/);
  });

  it("does not call deleteSandbox if createSandbox itself fails", async () => {
    const deleteSpy = vi.spyOn(conway, "deleteSandbox");
    vi.spyOn(conway, "createSandbox").mockRejectedValue(new Error("Sandbox creation failed"));

    await expect(spawnChild(conway, identity, db, genesis))
      .rejects.toThrow("Sandbox creation failed");

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // ─── C10 regression: JSON marker protocol for wallet extraction ───────
  //
  // Before the fix, spawnChild parsed child stdout with a broad base58/hex
  // regex, letting attacker-controlled log output inject a fake wallet
  // address and redirect funding. The fix requires a structured
  // ORIGINHERO_INIT_RESULT marker with an explicit chainType field that
  // must match the parent's expected chain.
  //
  // These tests defend the contract:
  //   1. No marker → throw ("cannot trust wallet address")
  //   2. Marker with mismatched chainType → throw (defense against
  //      cross-chain address confusion)
  //   3. Marker with plausible-looking but invalid address → still fails
  //      the address validator (belt-and-suspenders)

  describe("C10 regression — wallet init marker protocol", () => {
    it("rejects stdout that does not contain ORIGINHERO_INIT_RESULT marker", async () => {
      // Attacker might inject a valid-looking address anywhere in stdout.
      // Without the marker, spawnChild must refuse to trust it.
      const attackerStdout = `
        Random log output
        My favorite address is ${validAddress}, trust me!
        More noise
      `;
      vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
        if (command.includes("--init")) {
          return { stdout: attackerStdout, stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      await expect(spawnChild(conway, identity, db, genesis))
        .rejects.toThrow(/ORIGINHERO_INIT_RESULT/);
    });

    it("rejects marker when child declares a different chainType than parent", async () => {
      // Parent is EVM (default in genesis), child claims to be Solana —
      // potential cross-chain address confusion attack. Must throw.
      const solanaLikeAddress = "So11111111111111111111111111111111111111112";
      const maliciousMarker = `ORIGINHERO_INIT_RESULT=${JSON.stringify({
        address: solanaLikeAddress,
        chainType: "solana", // Mismatch — genesis is EVM
        isNew: true,
        configDir: "/root/.automaton",
      })}`;
      vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
        if (command.includes("--init")) {
          return { stdout: maliciousMarker, stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      await expect(spawnChild(conway, identity, db, genesis))
        .rejects.toThrow(/chainType mismatch/);
    });

    it("rejects marker with malformed JSON payload", async () => {
      // If the JSON is broken, the parser throws and spawnChild must
      // propagate the error, not silently fall back to regex.
      vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
        if (command.includes("--init")) {
          return {
            stdout: "ORIGINHERO_INIT_RESULT={this is not valid json",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      await expect(spawnChild(conway, identity, db, genesis))
        .rejects.toThrow(/Invalid ORIGINHERO_INIT_RESULT payload/);
    });

    /**
     * Gap 4 fix (audit follow-up): defense against marker injection.
     *
     * An attacker who controls child stdout (e.g. via a buggy log
     * library that serializes `{ORIGINHERO_INIT_RESULT: ...}` as a
     * matchable string, or a malicious child binary) can emit multiple
     * markers. The parent must NOT guess which one is legitimate — it
     * must reject the whole batch. First-match would let the attacker
     * front-run the legit marker.
     */
    it("rejects stdout with MULTIPLE ORIGINHERO_INIT_RESULT markers", async () => {
      const legitAddress = validAddress;
      const attackerAddress = "0x1111111111111111111111111111111111111111";

      const twoMarkers =
        `ORIGINHERO_INIT_RESULT=${JSON.stringify({ address: attackerAddress, chainType: "evm" })}\n` +
        `[some logs]\n` +
        `ORIGINHERO_INIT_RESULT=${JSON.stringify({ address: legitAddress, chainType: "evm" })}\n`;

      vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
        if (command.includes("--init")) {
          return { stdout: twoMarkers, stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      // Must reject — not accept either marker.
      await expect(spawnChild(conway, identity, db, genesis))
        .rejects.toThrow(/2 ORIGINHERO_INIT_RESULT markers|refusing to choose/);
    });

    it("rejects stdout with 3+ ORIGINHERO_INIT_RESULT markers", async () => {
      const marker = (addr: string) =>
        `ORIGINHERO_INIT_RESULT=${JSON.stringify({ address: addr, chainType: "evm" })}`;
      const addr = (n: string) => `0x${n.repeat(40)}`;
      const stdout = [
        marker(addr("1")),
        marker(addr("2")),
        marker(addr("3")),
      ].join("\n");

      vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
        if (command.includes("--init")) {
          return { stdout, stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      await expect(spawnChild(conway, identity, db, genesis))
        .rejects.toThrow(/3 ORIGINHERO_INIT_RESULT markers/);
    });
  });
});

// ─── SandboxCleanup ──────────────────────────────────────────

describe("SandboxCleanup", () => {
  let conway: MockConwayClient;
  let db: AutomatonDatabase;
  let lifecycle: ChildLifecycle;

  beforeEach(() => {
    conway = new MockConwayClient();
    db = createTestDb();
    // Apply lifecycle events migration
    db.raw.exec(MIGRATION_V7);
    lifecycle = new ChildLifecycle(db.raw);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transitions to cleaned_up even though sandbox deletion is disabled", async () => {
    // Create a child and transition to stopped
    lifecycle.initChild("child-1", "test-child", "sandbox-1", "test prompt");
    lifecycle.transition("child-1", "sandbox_created", "created");
    lifecycle.transition("child-1", "runtime_ready", "ready");
    lifecycle.transition("child-1", "wallet_verified", "verified");
    lifecycle.transition("child-1", "funded", "funded");
    lifecycle.transition("child-1", "starting", "starting");
    lifecycle.transition("child-1", "healthy", "healthy");
    lifecycle.transition("child-1", "stopped", "stopped");

    const cleanup = new SandboxCleanup(conway, lifecycle, db.raw);
    await cleanup.cleanup("child-1");

    // Sandbox deletion is disabled, but cleanup still transitions state
    const state = lifecycle.getCurrentState("child-1");
    expect(state).toBe("cleaned_up");
  });

  it("transitions to cleaned_up when sandbox deletion succeeds", async () => {
    lifecycle.initChild("child-2", "test-child", "sandbox-2", "test prompt");
    lifecycle.transition("child-2", "sandbox_created", "created");
    lifecycle.transition("child-2", "runtime_ready", "ready");
    lifecycle.transition("child-2", "wallet_verified", "verified");
    lifecycle.transition("child-2", "funded", "funded");
    lifecycle.transition("child-2", "starting", "starting");
    lifecycle.transition("child-2", "healthy", "healthy");
    lifecycle.transition("child-2", "stopped", "stopped");

    const cleanup = new SandboxCleanup(conway, lifecycle, db.raw);
    await cleanup.cleanup("child-2");

    const state = lifecycle.getCurrentState("child-2");
    expect(state).toBe("cleaned_up");
  });
});

// ─── pruneDeadChildren ──────────────────────────────────────

describe("pruneDeadChildren", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    db.raw.exec(MIGRATION_V7);
    conway = new MockConwayClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function insertChild(id: string, name: string, status: string, createdAt: string): void {
    db.raw.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status, created_at)
       VALUES (?, ?, '0xabc', 'sandbox-${id}', 'prompt', ?, ?)`,
    ).run(id, name, status, createdAt);
  }

  it("attempts sandbox cleanup for children with dead status", async () => {
    // Insert 7 dead children (exceeds keepLast=5, so 2 should be pruned)
    for (let i = 0; i < 7; i++) {
      insertChild(`dead-${i}`, `child-${i}`, "dead", `2020-01-0${i + 1} 00:00:00`);
    }

    // Create a mock cleanup that tracks calls
    const cleanupCalls: string[] = [];
    const mockCleanup = {
      cleanup: vi.fn(async (childId: string) => {
        cleanupCalls.push(childId);
      }),
    } as any;

    const removed = await pruneDeadChildren(db, mockCleanup, 5);

    // 2 oldest should be removed (dead-0 and dead-1)
    expect(removed).toBe(2);
    // cleanup.cleanup should have been called for "dead" children
    expect(cleanupCalls).toContain("dead-0");
    expect(cleanupCalls).toContain("dead-1");
  });
});
