/**
 * Client Factory
 *
 * Unified factory that selects between Conway Cloud and Local infrastructure
 * based on configuration. This is the single entry point for creating
 * a ConwayClient in OriginHero.
 *
 * Selection logic:
 * 1. If ORIGINHERO_MODE=local → LocalConwayClient (Docker + SQLite)
 * 2. If no Conway API key is configured → LocalConwayClient
 * 3. Otherwise → Conway Cloud ConwayClient (original behavior)
 *
 * OriginHero Phase 1
 */

import type Database from "better-sqlite3";
import type { ConwayClient } from "../types.js";
import { createConwayClient } from "../conway/client.js";
import { createLocalConwayClient } from "./client.js";
import type { DockerSandboxConfig } from "./docker-sandbox.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("client-factory");

export type ClientMode = "conway" | "local" | "auto";

export interface ClientFactoryOptions {
  /** Explicit mode selection. Default: "auto" */
  mode?: ClientMode;

  // Conway Cloud options (used when mode is "conway" or "auto" with API key)
  conwayApiUrl?: string;
  conwayApiKey?: string;

  // Shared
  sandboxId: string;

  // Local mode options
  db?: Database.Database;
  docker?: DockerSandboxConfig;
}

/**
 * Create the appropriate ConwayClient based on configuration.
 *
 * Returns { client, mode } so callers know which backend is active.
 */
export function createClient(
  options: ClientFactoryOptions,
): { client: ConwayClient; mode: "conway" | "local" } {
  const requestedMode = options.mode || process.env.ORIGINHERO_MODE as ClientMode || "auto";

  // Explicit local mode
  if (requestedMode === "local") {
    if (!options.db) {
      throw new Error("Local mode requires a database instance (options.db).");
    }
    logger.info("Creating LocalConwayClient (mode=local)");
    return {
      client: createLocalConwayClient({
        db: options.db,
        sandboxId: options.sandboxId,
        docker: options.docker,
      }),
      mode: "local",
    };
  }

  // Explicit Conway mode
  if (requestedMode === "conway") {
    if (!options.conwayApiKey) {
      throw new Error("Conway mode requires an API key (options.conwayApiKey).");
    }
    logger.info("Creating ConwayClient (mode=conway)");
    return {
      client: createConwayClient({
        apiUrl: options.conwayApiUrl || "https://api.conway.tech",
        apiKey: options.conwayApiKey,
        sandboxId: options.sandboxId,
      }),
      mode: "conway",
    };
  }

  // Auto mode: prefer Conway if API key exists, otherwise local.
  // conwayApiUrl has a default ("https://api.conway.tech") so only the key is required.
  if (options.conwayApiKey) {
    logger.info("Creating ConwayClient (mode=auto, Conway API key found)");
    return {
      client: createConwayClient({
        apiUrl: options.conwayApiUrl || "https://api.conway.tech",
        apiKey: options.conwayApiKey,
        sandboxId: options.sandboxId,
      }),
      mode: "conway",
    };
  }

  // Auto fallback to local
  if (!options.db) {
    throw new Error(
      "Auto mode fell through to local, but no database instance provided. " +
      "Either set ORIGINHERO_MODE=conway with a Conway API key, or provide options.db.",
    );
  }

  logger.info("Creating LocalConwayClient (mode=auto, no Conway API key)");
  return {
    client: createLocalConwayClient({
      db: options.db,
      sandboxId: options.sandboxId,
      docker: options.docker,
    }),
    mode: "local",
  };
}
