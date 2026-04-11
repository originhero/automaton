/**
 * OriginHero Dashboard API Server
 *
 * Lightweight HTTP API that exposes automaton state to the dashboard UI.
 * Runs alongside the agent loop on a configurable port (default: 3001).
 *
 * Endpoints:
 *   GET  /api/status          — Automaton state, uptime, credits, survival tier
 *   GET  /api/turns           — Recent agent turns (paginated)
 *   GET  /api/business        — Business config (repo, domains, servers, services)
 *   POST /api/business        — Update business config (onboarding wizard)
 *   GET  /api/business/health — Live health check of domains + servers
 *   GET  /api/config          — Current automaton config (sanitized, no secrets)
 *   POST /api/config          — Update config fields
 *   GET  /api/logs            — Structured log stream
 *   GET  /api/models          — Available inference models
 *   POST /api/command         — Send a command to the automaton (natural language)
 *   GET  /api/approvals       — Pending approval requests
 *   POST /api/approvals/:id   — Approve or reject an action
 *   POST /api/validate/repo   — Validate a GitHub repo URL
 *   POST /api/validate/server — Validate SSH connection to a server
 *   POST /api/validate/domain — Validate DNS resolution for a domain
 */

import http from "node:http";
import { createLogger } from "../observability/logger.js";
import type { AutomatonConfig, AutomatonDatabase, BusinessConfig, SetupIssue, LastError } from "../types.js";
import { getActiveGoals } from "../state/database.js";

const logger = createLogger("api");

export interface APIServerOptions {
  port: number;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  /** Callback to hot-reload config after dashboard changes it */
  onConfigUpdate?: (newConfig: Partial<AutomatonConfig>) => void;
  /** Callback to inject a command into the agent's input queue */
  onCommand?: (command: string) => void;
  /** Callback to respond to approval requests */
  onApproval?: (id: string, approved: boolean) => void;
  /** Reference to get live state */
  getState?: () => {
    state: string;
    uptimeSeconds: number;
    creditsCents: number;
    survivalTier: string;
    currentTurn: number;
  };
}

interface PendingApproval {
  id: string;
  action: string;
  description: string;
  riskLevel: string;
  createdAt: string;
  resolved: boolean;
  approved?: boolean;
}

// In-memory approval queue (will be persisted to SQLite later)
const pendingApprovals: PendingApproval[] = [];

export function addApproval(approval: Omit<PendingApproval, "resolved">): void {
  pendingApprovals.push({ ...approval, resolved: false });
}

export function createAPIServer(options: APIServerOptions): http.Server {
  const { port, config, db, onConfigUpdate, onCommand, onApproval, getState } = options;

  const server = http.createServer(async (req, res) => {
    // CORS headers for local dashboard
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      // ─── GET /api/status ──────────────────────────────────
      if (pathname === "/api/status" && req.method === "GET") {
        const liveState = getState?.() || {
          state: "unknown",
          uptimeSeconds: 0,
          creditsCents: 0,
          survivalTier: "unknown",
          currentTurn: 0,
        };

        // Read sleep metadata from KV store
        const sleepReason = db.getKV("sleep_reason") || null;
        const sleepDetail = db.getKV("sleep_detail") || null;
        const wakeAt = db.getKV("sleep_until") || null;

        // Read last errors
        let lastErrors: LastError[] = [];
        try {
          const rawErrors = db.getKV("last_errors");
          if (rawErrors) lastErrors = JSON.parse(rawErrors);
        } catch { /* ignore parse errors */ }

        // Read pending goals
        let pendingGoals: { id: string; title: string; status: string }[] = [];
        try {
          const rawGoals = db.getKV("pending_goals");
          if (rawGoals) pendingGoals = JSON.parse(rawGoals);
        } catch { /* ignore parse errors */ }

        // Infer required setup issues from error patterns
        const requiredSetup = inferSetupIssues(lastErrors, config);

        json(res, {
          name: config.name,
          version: config.version,
          ...liveState,
          businessName: config.business?.name || null,
          hasBusiness: !!config.business,
          turnCount: db.getTurnCount(),
          pendingApprovals: pendingApprovals.filter((a) => !a.resolved).length,
          sleepReason,
          sleepDetail,
          wakeAt,
          lastErrors,
          pendingGoals,
          requiredSetup,
        });
        return;
      }

      // ─── GET /api/activity ──────────────────────────────────
      if (pathname === "/api/activity" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "10", 10);
        const raw = db.raw;
        const stmt = raw.prepare(
          "SELECT * FROM turns ORDER BY rowid DESC LIMIT ?",
        );
        const turns = stmt.all(limit) as Array<{
          id: string;
          timestamp: string;
          thinking?: string;
          tool_calls?: string;
        }>;

        // Map tool names to agent types for the activity feed
        const toolToAgent: Record<string, string> = {
          exec: "deploy", git_clone: "deploy", write_file: "deploy", read_file: "deploy",
          server_status: "deploy", deploy_docker: "deploy",
          social_post: "marketing", create_content: "marketing",
          send_email: "email", check_inbox: "email",
          check_credits: "support", check_usdc_balance: "support",
          system_synopsis: "support", orchestrator_status: "support",
          business_info: "support", create_goal: "support",
        };

        const items = turns
          .filter((t) => t.tool_calls || t.thinking)
          .map((t) => {
            let agent = "support";
            let message = "Processing...";
            let type = "info";

            // Parse tool calls to determine agent and message
            if (t.tool_calls) {
              try {
                const calls = JSON.parse(t.tool_calls);
                if (Array.isArray(calls) && calls.length > 0) {
                  const toolName = calls[0].name || calls[0].tool || "";
                  agent = toolToAgent[toolName] || "support";
                  const args = calls[0].arguments || calls[0].input || {};
                  message = `${toolName}(${Object.keys(args).length > 0 ? "..." : ""})`;
                }
              } catch {
                message = "Tool execution";
              }
            } else if (t.thinking) {
              const thought = typeof t.thinking === "string" ? t.thinking : "";
              message = thought.slice(0, 120) + (thought.length > 120 ? "..." : "");
              type = "info";
            }

            // Determine type from result
            if (message.includes("ERROR") || message.includes("failed")) type = "error";
            else if (message.includes("Blocked")) type = "warning";
            else if (message.includes("written") || message.includes("created")) type = "success";

            return {
              id: t.id,
              agent,
              message,
              timestamp: t.timestamp,
              type,
            };
          });

        json(res, items);
        return;
      }

      // ─── GET /api/turns ───────────────────────────────────
      if (pathname === "/api/turns" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);

        // Get recent turns from DB
        const raw = db.raw;
        const stmt = raw.prepare(
          "SELECT * FROM turns ORDER BY rowid DESC LIMIT ? OFFSET ?",
        );
        const turns = stmt.all(limit, offset);

        json(res, { turns, total: db.getTurnCount() });
        return;
      }

      // ─── GET /api/business ────────────────────────────────
      if (pathname === "/api/business" && req.method === "GET") {
        json(res, {
          configured: !!config.business,
          business: config.business || null,
        });
        return;
      }

      // ─── POST /api/business ───────────────────────────────
      if (pathname === "/api/business" && req.method === "POST") {
        const body = await readBody(req);
        const businessUpdate = JSON.parse(body) as BusinessConfig;

        if (!businessUpdate.name || !businessUpdate.repo?.url) {
          json(res, { error: "Business config requires 'name' and 'repo.url'" }, 400);
          return;
        }

        config.business = businessUpdate;
        onConfigUpdate?.({ business: businessUpdate });

        logger.info(`Business config updated: ${businessUpdate.name}`);
        json(res, { success: true, business: businessUpdate });
        return;
      }

      // ─── GET /api/business/health ─────────────────────────
      if (pathname === "/api/business/health" && req.method === "GET") {
        if (!config.business) {
          json(res, { error: "No business configured" }, 404);
          return;
        }

        // Return a lightweight structure; actual health checks
        // are performed by the dashboard or the automaton tools
        json(res, {
          business: config.business.name,
          domains: config.business.domains.map((d) => ({
            fqdn: d.fqdn,
            role: d.role,
          })),
          servers: config.business.servers.map((s) => ({
            id: s.id,
            name: s.name,
            host: s.host ? "configured" : "missing",
            role: s.role,
          })),
          services: (config.business.services || []).map((svc) => ({
            name: svc.name,
            type: svc.type,
            hasKey: svc.apiKeyEnvVar ? !!process.env[svc.apiKeyEnvVar] : false,
          })),
        });
        return;
      }

      // ─── GET /api/config ──────────────────────────────────
      if (pathname === "/api/config" && req.method === "GET") {
        // Sanitize: remove API keys, show only structure
        const sanitized = {
          name: config.name,
          version: config.version,
          inferenceModel: config.inferenceModel,
          maxTokensPerTurn: config.maxTokensPerTurn,
          maxChildren: config.maxChildren,
          maxTurnsPerCycle: config.maxTurnsPerCycle,
          logLevel: config.logLevel,
          chainType: config.chainType,
          modelStrategy: config.modelStrategy,
          treasuryPolicy: config.treasuryPolicy,
          // Show which keys are configured, not the keys themselves
          providers: {
            openai: !!config.openaiApiKey,
            anthropic: !!config.anthropicApiKey,
            google: !!config.googleApiKey,
            ollama: !!config.ollamaBaseUrl,
            conway: !!config.conwayApiKey && config.conwayApiKey !== "",
          },
        };
        json(res, sanitized);
        return;
      }

      // ─── POST /api/config ─────────────────────────────────
      if (pathname === "/api/config" && req.method === "POST") {
        const body = await readBody(req);
        const updates = JSON.parse(body);

        // Only allow safe fields to be updated from UI
        const allowedFields = [
          "name", "inferenceModel", "maxTokensPerTurn", "maxTurnsPerCycle",
          "logLevel", "maxChildren", "modelStrategy", "treasuryPolicy",
        ];

        const filtered: Record<string, unknown> = {};
        for (const key of allowedFields) {
          if (key in updates) {
            filtered[key] = updates[key];
          }
        }

        Object.assign(config, filtered);
        onConfigUpdate?.(filtered as Partial<AutomatonConfig>);

        logger.info(`Config updated from dashboard: ${Object.keys(filtered).join(", ")}`);
        json(res, { success: true, updated: Object.keys(filtered) });
        return;
      }

      // ─── GET /api/models ──────────────────────────────────
      if (pathname === "/api/models" && req.method === "GET") {
        const raw = db.raw;
        let models: unknown[] = [];
        try {
          const stmt = raw.prepare("SELECT * FROM model_registry ORDER BY provider, model_id");
          models = stmt.all();
        } catch {
          // Table might not exist yet
        }
        json(res, { models });
        return;
      }

      // ─── POST /api/command ────────────────────────────────
      if (pathname === "/api/command" && req.method === "POST") {
        const body = await readBody(req);
        const { command } = JSON.parse(body);

        if (!command || typeof command !== "string") {
          json(res, { error: "command is required" }, 400);
          return;
        }

        onCommand?.(command);
        logger.info(`Command received from dashboard: ${command.slice(0, 80)}`);
        json(res, { success: true, queued: true });
        return;
      }

      // ─── GET /api/approvals ───────────────────────────────
      if (pathname === "/api/approvals" && req.method === "GET") {
        const showAll = url.searchParams.get("all") === "true";
        const filtered = showAll
          ? pendingApprovals
          : pendingApprovals.filter((a) => !a.resolved);
        json(res, { approvals: filtered });
        return;
      }

      // ─── POST /api/approvals/:id ─────────────────────────
      if (pathname.startsWith("/api/approvals/") && req.method === "POST") {
        const id = pathname.split("/").pop();
        const body = await readBody(req);
        const { approved } = JSON.parse(body);

        const approval = pendingApprovals.find((a) => a.id === id);
        if (!approval) {
          json(res, { error: "Approval not found" }, 404);
          return;
        }

        approval.resolved = true;
        approval.approved = !!approved;
        onApproval?.(id!, !!approved);

        logger.info(`Approval ${id}: ${approved ? "APPROVED" : "REJECTED"}`);
        json(res, { success: true, approval });
        return;
      }

      // ─── POST /api/validate/repo ──────────────────────────
      if (pathname === "/api/validate/repo" && req.method === "POST") {
        const body = await readBody(req);
        const { url: repoUrl, token } = JSON.parse(body);

        try {
          const { execSync } = await import("node:child_process");
          const testUrl = token && repoUrl.startsWith("https://")
            ? repoUrl.replace("https://", `https://${token}@`)
            : repoUrl;

          execSync(`git ls-remote --heads "${testUrl}" 2>&1`, {
            timeout: 15000,
            encoding: "utf-8",
          });
          json(res, { valid: true, message: "Repository accessible" });
        } catch (err: any) {
          json(res, { valid: false, message: err.message?.slice(0, 200) || "Cannot access repository" });
        }
        return;
      }

      // ─── POST /api/validate/server ────────────────────────
      if (pathname === "/api/validate/server" && req.method === "POST") {
        const body = await readBody(req);
        const { host, port: sshPort, user, keyPath } = JSON.parse(body);

        try {
          const { execSync } = await import("node:child_process");
          const sshArgs = [
            "ssh",
            "-o StrictHostKeyChecking=accept-new",
            "-o ConnectTimeout=5",
            `-p ${sshPort || 22}`,
            keyPath ? `-i "${keyPath}"` : "",
            `${user || "root"}@${host}`,
            '"echo OK && uname -a"',
          ].filter(Boolean).join(" ");

          const result = execSync(sshArgs, { timeout: 10000, encoding: "utf-8" });
          json(res, { valid: true, message: result.trim() });
        } catch (err: any) {
          json(res, { valid: false, message: err.message?.slice(0, 200) || "SSH connection failed" });
        }
        return;
      }

      // ─── POST /api/validate/domain ────────────────────────
      if (pathname === "/api/validate/domain" && req.method === "POST") {
        const body = await readBody(req);
        const { domain } = JSON.parse(body);

        try {
          const { execSync } = await import("node:child_process");
          const dns = execSync(`dig +short ${domain} A 2>/dev/null`, {
            timeout: 5000,
            encoding: "utf-8",
          }).trim();

          let https = "unknown";
          try {
            const httpResult = execSync(
              `curl -sI -o /dev/null -w "%{http_code}" --max-time 5 https://${domain}`,
              { timeout: 10000, encoding: "utf-8" },
            ).trim();
            https = httpResult;
          } catch {}

          json(res, {
            valid: !!dns,
            dns: dns || "no A record",
            https,
            message: dns ? `Resolves to ${dns}` : "Domain does not resolve",
          });
        } catch (err: any) {
          json(res, { valid: false, message: "DNS check failed" });
        }
        return;
      }

      // ─── 404 ──────────────────────────────────────────────
      json(res, { error: "Not found" }, 404);
    } catch (err: any) {
      logger.error(`API error: ${err.message}`);
      json(res, { error: err.message }, 500);
    }
  });

  server.listen(port, () => {
    logger.info(`OriginHero Dashboard API running on http://localhost:${port}`);
  });

  return server;
}

// ─── Helpers ──────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function inferSetupIssues(lastErrors: LastError[], config: AutomatonConfig): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const seen = new Set<string>();

  for (const err of lastErrors) {
    const msg = err.message.toLowerCase();

    if (!seen.has("llm_api_key") && (msg.includes("401") || msg.includes("invalid_api_key") || msg.includes("incorrect api key"))) {
      seen.add("llm_api_key");
      issues.push({
        id: "llm_api_key",
        label: "LLM API Key",
        status: "invalid",
        priority: "critical",
        action: "Update your API key in Settings > API Keys",
        settingsPath: "/settings",
      });
    }

    if (!seen.has("google_quota") && (msg.includes("429") || msg.includes("resource_exhausted") || msg.includes("quota"))) {
      seen.add("google_quota");
      issues.push({
        id: "google_quota",
        label: "API Quota",
        status: "exhausted",
        priority: "recommended",
        action: "Wait for quota reset or add billing to your cloud project",
        settingsPath: "/settings",
      });
    }

    if (!seen.has("mirofish") && (msg.includes("econnrefused") && msg.includes("5001"))) {
      seen.add("mirofish");
      issues.push({
        id: "mirofish",
        label: "Mirofish Service",
        status: "not_connected",
        priority: "recommended",
        action: "Start the Mirofish prediction service",
        settingsPath: "/settings",
      });
    }
  }

  return issues;
}
