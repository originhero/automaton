/**
 * Business Connector — Tools for operating a digital business.
 *
 * Provides the automaton with concrete abilities to interact with
 * the business it manages: SSH into production servers, manage the
 * GitHub repo, check domain/SSL status, and query connected services.
 *
 * All operations are gated behind the BusinessConfig from automaton.local.json.
 * If no business config is present, the tools gracefully report that.
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import type {
  BusinessConfig,
  ServerConfig,
  AutomatonTool,
  ToolContext,
} from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("business-connector");

// ─── Helper: resolve SSH key path from env var ─────────────────

function resolveSSHKeyPath(envVar?: string): string | undefined {
  if (!envVar) return undefined;
  const keyPath = process.env[envVar];
  if (!keyPath) return undefined;
  // Expand ~ to HOME
  const resolved = keyPath.startsWith("~")
    ? path.join(process.env.HOME || "/root", keyPath.slice(1))
    : keyPath;
  if (!fs.existsSync(resolved)) {
    logger.warn(`SSH key not found at ${resolved} (from ${envVar})`);
    return undefined;
  }
  return resolved;
}

// ─── Helper: build SSH command prefix ──────────────────────────

function buildSSHPrefix(server: ServerConfig): string[] {
  const args = [
    "ssh",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-p", String(server.sshPort || 22),
  ];

  const keyPath = resolveSSHKeyPath(server.sshKeyEnvVar);
  if (keyPath) {
    args.push("-i", keyPath);
  }

  args.push(`${server.sshUser || "root"}@${server.host}`);
  return args;
}

// ─── Helper: execute SSH command ───────────────────────────────

function execSSH(
  server: ServerConfig,
  command: string,
  timeoutMs = 30000,
): { stdout: string; stderr: string; exitCode: number } {
  const sshArgs = buildSSHPrefix(server);
  // Remove the leading "ssh" from the args array since spawnSync takes the command separately
  const [sshCmd, ...args] = sshArgs;
  // Pass the remote command as a separate argument to avoid shell injection.
  // SSH treats the remaining arguments after user@host as the remote command.
  args.push(command);

  const result = spawnSync(sshCmd, args, {
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 5, // 5MB
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
  };
}

// ─── Helper: get business config or error message ──────────────

function getBusinessOrError(ctx: ToolContext): BusinessConfig | string {
  const biz = ctx.config.business;
  if (!biz) {
    return "No business configured. Add a 'business' block to automaton.local.json with name, repo, domains, and servers.";
  }
  return biz;
}

function getServerOrError(
  biz: BusinessConfig,
  serverId?: string,
): ServerConfig | string {
  if (biz.servers.length === 0) {
    return "No servers configured in business config.";
  }
  if (!serverId) return biz.servers[0];
  const server = biz.servers.find((s) => s.id === serverId || s.name === serverId);
  if (!server) {
    return `Server '${serverId}' not found. Available: ${biz.servers.map((s) => s.id).join(", ")}`;
  }
  return server;
}

// ─── Business Tools ────────────────────────────────────────────

export function createBusinessTools(): AutomatonTool[] {
  return [
    // ── Business Info ──
    {
      name: "business_info",
      description:
        "Get information about the digital business this automaton operates: repo, domains, servers, services, and tech stack.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (_args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const lines: string[] = [
          `=== ${biz.name} ===`,
          biz.description ? `Description: ${biz.description}` : "",
          "",
          `📦 Repository: ${biz.repo.url}`,
          `   Branch: ${biz.repo.branch || "main"}`,
          biz.repo.localPath ? `   Local: ${biz.repo.localPath}` : "",
          "",
        ];

        if (biz.domains.length > 0) {
          lines.push("🌐 Domains:");
          for (const d of biz.domains) {
            lines.push(
              `   ${d.fqdn} [${d.role || "primary"}]${d.dnsProvider ? ` via ${d.dnsProvider}` : ""}${d.sslManaged ? " (SSL managed)" : ""}`,
            );
          }
          lines.push("");
        }

        if (biz.servers.length > 0) {
          lines.push("🖥️  Servers:");
          for (const s of biz.servers) {
            lines.push(
              `   ${s.id}: ${s.name} (${s.provider} ${s.type}) [${s.role || "production"}]`,
            );
            if (s.host) lines.push(`      Host: ${s.host}:${s.sshPort || 22}`);
            if (s.deployMethod) lines.push(`      Deploy: ${s.deployMethod}${s.deployPath ? ` → ${s.deployPath}` : ""}`);
          }
          lines.push("");
        }

        if (biz.services && biz.services.length > 0) {
          lines.push("🔗 Services:");
          for (const svc of biz.services) {
            lines.push(
              `   ${svc.name} (${svc.type})${svc.url ? ` — ${svc.url}` : ""}`,
            );
          }
          lines.push("");
        }

        if (biz.stack) {
          const s = biz.stack;
          lines.push("🛠️  Stack:");
          if (s.backend) lines.push(`   Backend: ${s.backend}`);
          if (s.frontend) lines.push(`   Frontend: ${s.frontend}`);
          if (s.languages) lines.push(`   Languages: ${s.languages.join(", ")}`);
          if (s.database) lines.push(`   Database: ${s.database}`);
          if (s.containerization) lines.push(`   Containers: ${s.containerization}`);
          if (s.reverseProxy) lines.push(`   Proxy: ${s.reverseProxy}`);
        }

        return lines.filter(Boolean).join("\n");
      },
    },

    // ── SSH Execute ──
    {
      name: "server_exec",
      description:
        "Execute a command on a production server via SSH. Use for deployments, log checks, service restarts, and monitoring.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute on the server",
          },
          server_id: {
            type: "string",
            description:
              "Server ID from business config (optional, defaults to first server)",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const server = getServerOrError(biz, args.server_id as string);
        if (typeof server === "string") return server;

        if (!server.host) {
          return `Server '${server.id}' has no host configured. Cannot SSH.`;
        }

        logger.info(
          `server_exec on ${server.id}: ${(args.command as string).slice(0, 80)}...`,
        );

        const result = execSSH(
          server,
          args.command as string,
          (args.timeout_ms as number) || 30000,
        );

        const output: string[] = [];
        if (result.stdout) output.push(result.stdout);
        if (result.stderr) output.push(`[stderr] ${result.stderr}`);
        output.push(`[exit code: ${result.exitCode}]`);
        return output.join("\n");
      },
    },

    // ── Server Status ──
    {
      name: "server_status",
      description:
        "Quick health check of a production server: uptime, load, memory, disk, and running services.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          server_id: {
            type: "string",
            description: "Server ID (optional, defaults to first server)",
          },
        },
        required: [],
      },
      execute: async (args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const server = getServerOrError(biz, args.server_id as string);
        if (typeof server === "string") return server;

        if (!server.host) {
          return `Server '${server.id}' has no host configured.`;
        }

        const statusCmd = [
          'echo "=== Uptime ===" && uptime',
          'echo "\\n=== Memory ===" && free -h',
          'echo "\\n=== Disk ===" && df -h / | tail -1',
          'echo "\\n=== Load ===" && cat /proc/loadavg',
          'echo "\\n=== Docker ===" && (docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}" 2>/dev/null || echo "Docker not available")',
          'echo "\\n=== Services ===" && (systemctl list-units --state=running --type=service --no-pager --no-legend 2>/dev/null | head -20 || echo "systemctl not available")',
        ].join(" && ");

        const result = execSSH(server, statusCmd, 15000);
        return result.stdout || result.stderr || `Exit code: ${result.exitCode}`;
      },
    },

    // ── Server Logs ──
    {
      name: "server_logs",
      description:
        "Fetch recent logs from a service running on the production server.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description:
              'Service name (docker container name, systemd unit, or "nginx"/"app")',
          },
          lines: {
            type: "number",
            description: "Number of lines to fetch (default: 50)",
          },
          server_id: {
            type: "string",
            description: "Server ID (optional)",
          },
        },
        required: ["service"],
      },
      execute: async (args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const server = getServerOrError(biz, args.server_id as string);
        if (typeof server === "string") return server;

        if (!server.host) {
          return `Server '${server.id}' has no host configured.`;
        }

        const service = args.service as string;
        const lines = (args.lines as number) || 50;

        // Try docker first, then journalctl, then log files
        const logCmd = [
          `docker logs --tail ${lines} ${service} 2>/dev/null`,
          `|| journalctl -u ${service} -n ${lines} --no-pager 2>/dev/null`,
          `|| tail -${lines} /var/log/${service}.log 2>/dev/null`,
          `|| echo "Could not find logs for service '${service}'"`,
        ].join(" ");

        const result = execSSH(server, logCmd, 15000);
        return result.stdout || result.stderr || "No output";
      },
    },

    // ── Deploy ──
    {
      name: "deploy",
      description:
        "Deploy the latest code to a production server using the configured deploy method (git-pull, docker, etc.).",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          server_id: {
            type: "string",
            description: "Server ID (optional, defaults to first server)",
          },
          branch: {
            type: "string",
            description: "Branch to deploy (optional, uses default from repo config)",
          },
        },
        required: [],
      },
      execute: async (args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const server = getServerOrError(biz, args.server_id as string);
        if (typeof server === "string") return server;

        if (!server.host) return `Server '${server.id}' has no host configured.`;
        if (!server.deployPath) return `Server '${server.id}' has no deployPath configured.`;

        const branch = (args.branch as string) || biz.repo.branch || "main";
        const method = server.deployMethod || "git-pull";

        let deployCmd: string;

        switch (method) {
          case "git-pull":
            deployCmd = [
              `cd ${server.deployPath}`,
              `git fetch origin`,
              `git checkout ${branch}`,
              `git pull origin ${branch}`,
              `echo "Deploy complete: $(git log -1 --oneline)"`,
            ].join(" && ");
            break;

          case "docker":
            deployCmd = [
              `cd ${server.deployPath}`,
              `git pull origin ${branch}`,
              `docker compose down`,
              `docker compose build`,
              `docker compose up -d`,
              `echo "Docker deploy complete"`,
              `docker compose ps`,
            ].join(" && ");
            break;

          case "rsync":
            // For rsync, we build locally and push — but from server side we just pull
            deployCmd = [
              `cd ${server.deployPath}`,
              `git pull origin ${branch}`,
              `echo "Code updated. Restart services manually or configure a post-deploy hook."`,
            ].join(" && ");
            break;

          default:
            return `Unknown deploy method '${method}'. Supported: git-pull, docker, rsync`;
        }

        logger.info(`Deploying ${biz.name} to ${server.id} via ${method}`);
        const result = execSSH(server, deployCmd, 120000); // 2 min timeout for deploys
        const output: string[] = [];
        if (result.stdout) output.push(result.stdout);
        if (result.stderr) output.push(`[stderr] ${result.stderr}`);
        output.push(`[exit code: ${result.exitCode}]`);
        return output.join("\n");
      },
    },

    // ── Domain Check ──
    {
      name: "domain_check",
      description:
        "Check the status of the business domain(s): DNS resolution, HTTP response, and SSL certificate validity.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description:
              "Specific domain to check (optional, checks all configured domains)",
          },
        },
        required: [],
      },
      execute: async (args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const domainsToCheck =
          args.domain
            ? biz.domains.filter((d) => d.fqdn === args.domain)
            : biz.domains;

        if (domainsToCheck.length === 0) {
          return args.domain
            ? `Domain '${args.domain}' not found in config.`
            : "No domains configured.";
        }

        const results: string[] = [];

        for (const d of domainsToCheck) {
          results.push(`=== ${d.fqdn} [${d.role || "primary"}] ===`);

          // DNS check
          try {
            const dns = execSync(`dig +short ${d.fqdn} A 2>/dev/null || nslookup ${d.fqdn} 2>/dev/null | grep Address | tail -1`, {
              encoding: "utf-8",
              timeout: 10000,
            }).trim();
            results.push(`DNS: ${dns || "no A record"}`);
          } catch {
            results.push("DNS: check failed");
          }

          // HTTP check
          try {
            const http = execSync(
              `curl -sI -o /dev/null -w "%{http_code} %{time_total}s %{ssl_verify_result}" --max-time 10 https://${d.fqdn}`,
              { encoding: "utf-8", timeout: 15000 },
            ).trim();
            const [code, time, ssl] = http.split(" ");
            results.push(`HTTPS: ${code} (${time}) SSL verify: ${ssl === "0" ? "OK" : `FAIL(${ssl})`}`);
          } catch {
            results.push("HTTPS: check failed");
          }

          // SSL expiry
          try {
            const sslExpiry = execSync(
              `echo | openssl s_client -servername ${d.fqdn} -connect ${d.fqdn}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`,
              { encoding: "utf-8", timeout: 10000 },
            ).trim();
            results.push(`SSL Expiry: ${sslExpiry.replace("notAfter=", "")}`);
          } catch {
            results.push("SSL Expiry: check failed");
          }

          results.push("");
        }

        return results.join("\n");
      },
    },

    // ── Repo Setup (clone if needed) ──
    {
      name: "business_repo_setup",
      description:
        "Clone the business repo locally if not already cloned. Sets up the working copy for code analysis and changes.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Force re-clone even if directory exists",
          },
        },
        required: [],
      },
      execute: async (args, ctx) => {
        const biz = getBusinessOrError(ctx);
        if (typeof biz === "string") return biz;

        const localPath =
          biz.repo.localPath ||
          path.join(process.env.HOME || "/root", "business-repo");

        if (fs.existsSync(path.join(localPath, ".git")) && !args.force) {
          // Already cloned — just pull latest
          try {
            const branch = biz.repo.branch || "main";
            execSync(`cd "${localPath}" && git fetch origin && git pull origin ${branch}`, {
              encoding: "utf-8",
              timeout: 30000,
            });
            return `Repo already cloned at ${localPath}. Pulled latest from ${branch}.`;
          } catch (err: any) {
            return `Repo exists at ${localPath} but pull failed: ${err.message}`;
          }
        }

        // Build clone URL with token if available
        let cloneUrl = biz.repo.url;
        if (biz.repo.accessTokenEnvVar) {
          const token = process.env[biz.repo.accessTokenEnvVar];
          if (token && cloneUrl.startsWith("https://")) {
            cloneUrl = cloneUrl.replace("https://", `https://${token}@`);
          }
        }

        try {
          if (fs.existsSync(localPath) && args.force) {
            execSync(`rm -rf "${localPath}"`, { timeout: 10000 });
          }

          const parentDir = path.dirname(localPath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }

          execSync(
            `git clone --branch ${biz.repo.branch || "main"} "${cloneUrl}" "${localPath}"`,
            { encoding: "utf-8", timeout: 120000 },
          );
          return `Repo cloned to ${localPath} on branch ${biz.repo.branch || "main"}.`;
        } catch (err: any) {
          return `Clone failed: ${err.message}`;
        }
      },
    },
  ];
}
