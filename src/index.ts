#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createClient as createClientFactory } from "./local/client-factory.js";
import { getCreditsTracker } from "./local/index.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { consumeNextWakeEvent, insertWakeEvent } from "./state/database.js";
import { runAgentLoop } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type { AutomatonIdentity, AutomatonConfig, AgentState, AgentTurn, Skill, SocialClientInterface } from "./types.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { bootstrapTopup } from "./conway/topup.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "viem";

const logger = createLogger("main");
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton task           Run a single task from stdin (Paperclip mode)
  automaton --setup        Re-run the interactive setup wizard
  automaton --configure    Edit configuration (providers, model, treasury, general)
  automaton --pick-model   Interactively pick the active inference model
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    // Read chain type from genesis.json if written by parent during spawn
    let initChainType: import("./identity/chain.js").ChainType | undefined;
    try {
      const genesisPath = path.join(getAutomatonDir(), "genesis.json");
      if (fs.existsSync(genesisPath)) {
        const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
        initChainType = genesis.chainType;
      }
    } catch {}
    const { chainIdentity, isNew } = await getWallet(initChainType);
    logger.info(
      JSON.stringify({
        address: chainIdentity.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  // ─── Task Subcommand (Paperclip mode) ────────────────────────
  if (args[0] === "task") {
    const { runTaskCli } = await import("./cli/task.js");

    await runTaskCli(args.slice(1), async () => {
      // Minimal boot: config, wallet, db, client, inference, identity
      let config = loadConfig();
      if (!config) {
        throw new Error("Automaton is not configured. Run `automaton --setup` first.");
      }

      const { account, chainIdentity, chainType: walletChainType } = await getWallet();
      const resolvedChainType = config.chainType || walletChainType || "evm";
      const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
      const isLocalMode = process.env.ORIGINHERO_MODE === "local";
      if (!apiKey && !isLocalMode) {
        throw new Error("No API key found. Run: automaton --provision (or set ORIGINHERO_MODE=local)");
      }

      const dbPath = resolvePath(config.dbPath);
      const db = createDatabase(dbPath);

      // Persist createdAt (same as run())
      const existingCreatedAt = db.getIdentity("createdAt");
      const createdAt = existingCreatedAt || new Date().toISOString();
      if (!existingCreatedAt) {
        db.setIdentity("createdAt", createdAt);
      }

      const identity: AutomatonIdentity = {
        name: config.name,
        address: chainIdentity.address,
        account,
        creatorAddress: config.creatorAddress,
        sandboxId: config.sandboxId,
        apiKey: apiKey || "",
        createdAt,
        chainType: resolvedChainType,
        chainIdentity,
      };

      // Create client (same as run())
      const { client: conway } = createClientFactory({
        mode: (process.env.ORIGINHERO_MODE as any) || "auto",
        conwayApiUrl: config.conwayApiUrl,
        conwayApiKey: apiKey || undefined,
        sandboxId: config.sandboxId,
        db: db.raw,
      });

      // Create inference client (same as run())
      const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;
      const modelRegistry = new ModelRegistry(db.raw);
      modelRegistry.initialize();
      const googleApiKey = process.env.GOOGLE_API_KEY || config.googleApiKey;

      const providerKeys: Record<string, string | undefined> = {
        openai: config.openaiApiKey,
        anthropic: config.anthropicApiKey,
        google: googleApiKey,
        conway: apiKey || undefined,
        ollama: ollamaBaseUrl,
      };
      for (const model of modelRegistry.getAll()) {
        const hasKey = !!providerKeys[model.provider];
        if (!hasKey && model.enabled) {
          modelRegistry.setEnabled(model.modelId, false);
        }
      }

      const inference = createInferenceClient({
        apiUrl: config.conwayApiUrl,
        apiKey: apiKey || "",
        defaultModel: config.inferenceModel,
        maxTokens: config.maxTokensPerTurn,
        lowComputeModel: config.modelStrategy?.lowComputeModel || "gpt-5-mini",
        openaiApiKey: config.openaiApiKey,
        anthropicApiKey: config.anthropicApiKey,
        googleApiKey,
        ollamaBaseUrl,
        getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
      });

      // Build the TaskRunnerDeps with a wrapper around the real runAgentLoop
      return {
        config,
        db,
        conway,
        inference,
        identity,
        runAgentLoop: async (options) => {
          const collectedTurns: AgentTurn[] = [];

          // Inject the task input as an inbox message so the agent processes it.
          // The real loop builds its own wakeup prompt for the first turn, then
          // picks up inbox messages on subsequent turns.  By inserting the task
          // prompt as a creator inbox message, the agent receives it.
          db.insertInboxMessage({
            id: randomUUID(),
            from: config.creatorAddress,
            to: identity.address,
            content: options.input,
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          });

          // Override maxTurnsPerCycle so the real loop respects the task's limit
          const taskConfig: AutomatonConfig = {
            ...options.config,
            maxTurnsPerCycle: options.maxTurns,
          };

          // Wire credits tracker so inference costs are deducted from
          // the virtual balance (fix: previously dead code)
          const creditsTracker = (options.conway as any).__creditsTracker as
            | { recordInferenceCost(p: { promptTokens: number; completionTokens: number; model: string; provider: string }): void }
            | undefined;

          await runAgentLoop({
            identity: options.identity,
            config: taskConfig,
            db: options.db,
            conway: options.conway,
            inference: options.inference,
            onTurnComplete: (turn) => {
              collectedTurns.push(turn);
              options.onTurn(turn);

              // Deduct inference cost from virtual credit balance
              if (creditsTracker && turn.costCents > 0) {
                try {
                  creditsTracker.recordInferenceCost({
                    promptTokens: turn.tokenUsage?.promptTokens ?? 0,
                    completionTokens: turn.tokenUsage?.completionTokens ?? 0,
                    model: taskConfig.inferenceModel || "unknown",
                    provider: "local",
                  });
                } catch {
                  // Non-fatal — don't crash the agent loop over credit tracking
                }
              }
            },
          });

          const finalState = db.getAgentState();

          return {
            turns: collectedTurns,
            finalState,
          };
        },
      };
    });

    process.exit(process.exitCode ?? 0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  logger.info('Run "automaton --help" for usage information.');
  logger.info('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.info("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  logger.info(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Load wallet (chain-aware)
  const { account, chainIdentity, chainType: walletChainType } = await getWallet();
  const resolvedChainType = config.chainType || walletChainType || "evm";
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  const isLocalMode = process.env.ORIGINHERO_MODE === "local";
  if (!apiKey && !isLocalMode) {
    logger.error("No API key found. Run: automaton --provision (or set ORIGINHERO_MODE=local)");
    process.exit(1);
  }

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  // Build identity (chain-aware)
  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey: apiKey || "",
    createdAt,
    chainType: resolvedChainType,
    chainIdentity,
  };

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", resolvedChainType);
  db.setIdentity("sandbox", config.sandboxId);
  const storedAutomatonId = db.getIdentity("automatonId");
  const automatonId = storedAutomatonId || config.sandboxId || randomUUID();
  if (!storedAutomatonId) {
    db.setIdentity("automatonId", automatonId);
  }

  // Create Conway client — uses factory to select between Conway Cloud and Local
  const { client: conway, mode: clientMode } = createClientFactory({
    mode: (process.env.ORIGINHERO_MODE as any) || "auto",
    conwayApiUrl: config.conwayApiUrl,
    conwayApiKey: apiKey || undefined,
    sandboxId: config.sandboxId,
    db: db.raw, // Pass raw better-sqlite3 instance for local mode
  });
  logger.info(`[${new Date().toISOString()}] Client mode: ${clientMode}`);

  // Register automaton identity (one-time, immutable)
  // In local mode, registration goes to SQLite instead of Conway Cloud.
  const registrationState = db.getIdentity("conwayRegistrationStatus");
  if (registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt
        ? keccak256(toHex(config.genesisPrompt))
        : undefined;
      await conway.registerAutomaton({
        automatonId,
        automatonAddress: chainIdentity.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
        chainType: resolvedChainType,
        chainIdentity,
      });
      db.setIdentity("conwayRegistrationStatus", "registered");
      logger.info(`[${new Date().toISOString()}] Automaton identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("conwayRegistrationStatus", "conflict");
        logger.warn(`[${new Date().toISOString()}] Automaton identity conflict: ${err.message}`);
      } else {
        db.setIdentity("conwayRegistrationStatus", "failed");
        logger.warn(`[${new Date().toISOString()}] Automaton identity registration failed: ${err.message}`);
      }
    }
  }

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  const googleApiKey = process.env.GOOGLE_API_KEY || config.googleApiKey;

  // Disable models whose provider has no API key configured.
  // This ensures the InferenceRouter skips models it can't actually call.
  const providerKeys: Record<string, string | undefined> = {
    openai: config.openaiApiKey,
    anthropic: config.anthropicApiKey,
    google: googleApiKey,
    conway: apiKey || undefined,
    ollama: ollamaBaseUrl,
  };
  for (const model of modelRegistry.getAll()) {
    const hasKey = !!providerKeys[model.provider];
    if (!hasKey && model.enabled) {
      modelRegistry.setEnabled(model.modelId, false);
      logger.info(`[${new Date().toISOString()}] Disabled ${model.modelId} (no ${model.provider} API key)`);
    }
  }
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey: apiKey || "",
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    lowComputeModel: config.modelStrategy?.lowComputeModel || "gpt-5-mini",
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    googleApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
  });

  if (ollamaBaseUrl) {
    logger.info(`[${new Date().toISOString()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Create social client (chain-aware: pass ChainIdentity for Solana signing)
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, resolvedChainType === "solana" ? chainIdentity : account);
    logger.info(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Initialize PolicyEngine + SpendTracker (Phase 1.4)
  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    logger.info(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Bootstrap topup: buy minimum credits ($5) from USDC so the agent can start.
  // In local mode, credits are virtual — skip Conway topup.
  if (clientMode === "conway") {
    try {
      let bootstrapTimer: ReturnType<typeof setTimeout>;
      const bootstrapTimeout = new Promise<null>((_, reject) => {
        bootstrapTimer = setTimeout(() => reject(new Error("bootstrap topup timed out")), 15_000);
      });
      try {
        await Promise.race([
          (async () => {
            const creditsCents = await conway.getCreditsBalance().catch(() => 0);
            const topupResult = await bootstrapTopup({
              apiUrl: config.conwayApiUrl,
              account,
              creditsCents,
              chainType: resolvedChainType,
            });
            if (topupResult?.success) {
              logger.info(
                `[${new Date().toISOString()}] Bootstrap topup: +$${topupResult.amountUsd} credits from USDC`,
              );
            }
          })(),
          bootstrapTimeout,
        ]);
      } finally {
        clearTimeout(bootstrapTimer!);
      }
    } catch (err: any) {
      logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
    }
  } else {
    const localBalance = await conway.getCreditsBalance().catch(() => 0);
    logger.info(`[${new Date().toISOString()}] Local mode — virtual credits: $${(localBalance / 100).toFixed(2)}`);
  }

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    conway,
    social,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      // Phase 1.1: Use wake_events table instead of KV wake_request
      insertWakeEvent(db.raw, 'heartbeat', reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // ─── Dashboard API Server ───────────────────────────────────
  const apiPort = parseInt(process.env.ORIGINHERO_API_PORT || "3001", 10);
  let apiServer: import("http").Server | null = null;
  let liveState = {
    state: "waking" as string,
    uptimeSeconds: 0,
    creditsCents: 0,
    survivalTier: "normal",
    currentTurn: 0,
  };
  const startTime = Date.now();

  try {
    const { createAPIServer } = await import("./api/server.js");
    apiServer = createAPIServer({
      port: apiPort,
      config,
      db,
      getState: () => ({
        ...liveState,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      }),
      onConfigUpdate: (updates) => {
        Object.assign(config, updates);
        // Persist updated config to disk
        const { saveConfig } = require("./config.js");
        saveConfig(config);
        logger.info("Config updated from dashboard and saved to disk");
      },
      onCommand: (command) => {
        insertWakeEvent(db.raw, "creator", command);
        logger.info(`Command queued from dashboard: ${command.slice(0, 80)}`);
      },
    });
  } catch (err) {
    logger.warn(`Dashboard API failed to start (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    if (apiServer) apiServer.close();
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        onStateChange: (state: AgentState) => {
          liveState.state = state;
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          liveState.currentTurn++;
          liveState.creditsCents = turn.costCents
            ? (liveState.creditsCents - turn.costCents)
            : liveState.creditsCents;
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );

          // Deduct inference cost from virtual credit balance (local mode)
          const ct = (conway as any).__creditsTracker as
            | { recordInferenceCost(p: { promptTokens: number; completionTokens: number; model: string; provider: string }): void }
            | undefined;
          if (ct && turn.costCents > 0) {
            try {
              ct.recordInferenceCost({
                promptTokens: turn.tokenUsage?.promptTokens ?? 0,
                completionTokens: turn.tokenUsage?.completionTokens ?? 0,
                model: config.inferenceModel || "unknown",
                provider: "local",
              });
            } catch {
              // Non-fatal
            }
          }
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Phase 1.1: Check for wake events from wake_events table (atomic consume)
          const wakeEvent = consumeNextWakeEvent(db.raw);
          if (wakeEvent) {
            logger.info(
              `[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`,
            );
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
