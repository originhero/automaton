/**
 * Docker Sandbox Backend
 *
 * Provides isolated execution environments using Docker containers.
 * Each sandbox is a Docker container with a configurable image,
 * resource limits, and port mapping.
 *
 * OriginHero Phase 1: LocalConwayClient — replaces Conway Cloud sandboxes.
 */

import { execSync, exec as execCallback } from "child_process";
import { promisify } from "util";
import net from "net";
import { randomUUID } from "crypto";
import type { ExecResult, PortInfo, CreateSandboxOptions, SandboxInfo } from "../types.js";
import { createLogger } from "../observability/logger.js";

const execAsync = promisify(execCallback);
const logger = createLogger("docker-sandbox");

/**
 * Validate a file path to prevent shell injection.
 * Only allows alphanumeric characters, dots, underscores, hyphens, slashes, and spaces.
 * Rejects path traversal via "..".
 */
function validatePath(p: string): string {
  if (!/^[a-zA-Z0-9_./ -]+$/.test(p) || p.includes("..")) {
    throw new Error("Invalid file path: " + p);
  }
  return p;
}

/**
 * Validate a sandbox/container ID to prevent shell injection.
 * Only allows alphanumeric characters, dots, underscores, and hyphens.
 * Must start with an alphanumeric character.
 */
function validateId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("Invalid sandbox ID: " + id);
  }
  return id;
}

const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_WORK_DIR = "/root";
const CONTAINER_PREFIX = "originhero-sandbox-";

export interface DockerSandboxConfig {
  /** Docker image to use for new sandboxes. Default: ubuntu:22.04 */
  image?: string;
  /** Working directory inside the container. Default: /root */
  workDir?: string;
  /** Network mode for containers. Default: bridge */
  networkMode?: string;
  /** Max container memory (e.g. "512m"). Default: 512m */
  memoryLimit?: string;
  /** CPU quota (e.g. 1.0 = 1 CPU). Default: 1.0 */
  cpuLimit?: number;
}

interface ManagedContainer {
  containerId: string;
  sandboxId: string;
  name: string;
  image: string;
  status: string;
  createdAt: string;
  ports: Map<number, number>; // container port → host port
}

/**
 * Check if Docker is available and running.
 */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export class DockerSandbox {
  private containers: Map<string, ManagedContainer> = new Map();
  private ownContainerId: string | null = null;
  private config: Required<DockerSandboxConfig>;

  constructor(config?: DockerSandboxConfig) {
    this.config = {
      image: config?.image || DEFAULT_IMAGE,
      workDir: config?.workDir || DEFAULT_WORK_DIR,
      networkMode: config?.networkMode || "bridge",
      memoryLimit: config?.memoryLimit || "512m",
      cpuLimit: config?.cpuLimit || 1.0,
    };
  }

  /**
   * Initialize the "own" sandbox — the primary container for this automaton.
   * Creates a long-running container if one doesn't already exist.
   */
  async initOwnSandbox(sandboxId: string): Promise<void> {
    validateId(sandboxId);
    const containerName = `${CONTAINER_PREFIX}${sandboxId}`;

    // Check if container already exists and is running
    try {
      const { stdout } = await execAsync(
        `docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null`,
      );
      if (stdout.trim() === "true") {
        // Get actual container ID
        const { stdout: idOut } = await execAsync(
          `docker inspect --format='{{.Id}}' ${containerName}`,
        );
        this.ownContainerId = idOut.trim().slice(0, 12);
        logger.info(`Reusing existing sandbox container: ${containerName}`);
        return;
      }
      // Container exists but stopped — remove and recreate
      await execAsync(`docker rm -f ${containerName} 2>/dev/null`).catch(() => {});
    } catch {
      // Container doesn't exist — will create below
    }

    // Create and start the container
    const cmd = [
      "docker run -d",
      `--name ${containerName}`,
      `--memory=${this.config.memoryLimit}`,
      `--cpus=${this.config.cpuLimit}`,
      `--network=${this.config.networkMode}`,
      `-w ${this.config.workDir}`,
      "--restart=unless-stopped",
      this.config.image,
      "tail -f /dev/null", // Keep container alive
    ].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      this.ownContainerId = stdout.trim().slice(0, 12);
      logger.info(`Created sandbox container: ${containerName} (${this.ownContainerId})`);
    } catch (err: any) {
      throw new Error(`Failed to create Docker sandbox: ${err.message}`);
    }
  }

  /**
   * Execute a command in the own sandbox container.
   */
  async exec(command: string, timeout?: number): Promise<ExecResult> {
    if (!this.ownContainerId) {
      throw new Error("Own sandbox not initialized. Call initOwnSandbox() first.");
    }

    const timeoutMs = timeout || 30_000;
    const escapedCommand = command.replace(/'/g, "'\\''");

    try {
      const { stdout, stderr } = await execAsync(
        `docker exec ${this.ownContainerId} sh -c '${escapedCommand}'`,
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      );
      return { stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.code ?? 1,
      };
    }
  }

  /**
   * Write a file inside the own sandbox container.
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    if (!this.ownContainerId) {
      throw new Error("Own sandbox not initialized.");
    }

    validatePath(filePath);

    // Ensure parent directory exists
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) {
      await this.exec(`mkdir -p '${dir}'`);
    }

    // Write content via stdin to avoid shell escaping issues
    const escapedContent = Buffer.from(content).toString("base64");
    await this.exec(`echo '${escapedContent}' | base64 -d > '${filePath}'`);
  }

  /**
   * Read a file from the own sandbox container.
   */
  async readFile(filePath: string): Promise<string> {
    if (!this.ownContainerId) {
      throw new Error("Own sandbox not initialized.");
    }

    validatePath(filePath);
    const result = await this.exec(`cat '${filePath}'`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${filePath}: ${result.stderr}`);
    }
    return result.stdout;
  }

  /**
   * Expose a port from the own sandbox by mapping it to a host port.
   */
  async exposePort(port: number): Promise<PortInfo> {
    if (!this.ownContainerId) {
      throw new Error("Own sandbox not initialized.");
    }

    // For Docker, we need to use socat or docker port mapping
    // Since the container is already running, we use socat inside the container
    // and rely on Docker networking
    //
    // Note: Dynamic port exposure on running containers is limited.
    // For MVP, we return the container's port directly accessible via Docker network.
    const hostPort = await this.findAvailableHostPort();

    // Use a separate socat container to proxy traffic
    const proxyName = `${CONTAINER_PREFIX}proxy-${port}-${randomUUID().slice(0, 8)}`;
    try {
      await execAsync(
        `docker run -d --name ${proxyName} --network=${this.config.networkMode} ` +
        `-p ${hostPort}:${port} alpine/socat TCP-LISTEN:${port},fork,reuseaddr ` +
        `TCP:${this.ownContainerId}:${port}`,
      );
    } catch {
      // Fallback: just report the port — the user can use docker network directly
      logger.warn(`Port proxy setup failed for ${port}, returning direct container port`);
    }

    return {
      port,
      publicUrl: `http://localhost:${hostPort}`,
      sandboxId: this.ownContainerId,
    };
  }

  /**
   * Remove an exposed port mapping.
   */
  async removePort(port: number): Promise<void> {
    // Find and remove proxy containers for this port
    try {
      const { stdout } = await execAsync(
        `docker ps --filter "name=${CONTAINER_PREFIX}proxy-${port}" --format "{{.Names}}"`,
      );
      const names = stdout.trim().split("\n").filter(Boolean);
      for (const name of names) {
        await execAsync(`docker rm -f ${name}`).catch(() => {});
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Create a new sandbox container for child automatons.
   */
  async createSandbox(options: CreateSandboxOptions): Promise<SandboxInfo> {
    const sandboxId = randomUUID();
    const containerName = `${CONTAINER_PREFIX}${sandboxId.slice(0, 8)}`;

    const memory = options.memoryMb ? `${options.memoryMb}m` : this.config.memoryLimit;
    const cpus = options.vcpu || this.config.cpuLimit;

    const cmd = [
      "docker run -d",
      `--name ${containerName}`,
      `--memory=${memory}`,
      `--cpus=${cpus}`,
      `--network=${this.config.networkMode}`,
      `-w ${this.config.workDir}`,
      this.config.image,
      "tail -f /dev/null",
    ].join(" ");

    const { stdout } = await execAsync(cmd);
    const containerId = stdout.trim().slice(0, 12);

    const info: ManagedContainer = {
      containerId,
      sandboxId,
      name: options.name || containerName,
      image: this.config.image,
      status: "running",
      createdAt: new Date().toISOString(),
      ports: new Map(),
    };
    this.containers.set(sandboxId, info);

    return {
      id: sandboxId,
      status: "running",
      region: "local",
      vcpu: cpus,
      memoryMb: options.memoryMb || 512,
      diskGb: options.diskGb || 5,
      createdAt: info.createdAt,
    };
  }

  /**
   * Delete (stop and remove) a sandbox container.
   */
  async deleteSandbox(sandboxId: string): Promise<void> {
    const container = this.containers.get(sandboxId);
    if (!container) {
      logger.warn(`Sandbox ${sandboxId} not found in managed containers.`);
      return;
    }

    try {
      await execAsync(`docker rm -f ${container.containerId}`);
      this.containers.delete(sandboxId);
      logger.info(`Deleted sandbox container: ${container.containerId}`);
    } catch (err: any) {
      logger.warn(`Failed to delete sandbox ${sandboxId}: ${err.message}`);
    }
  }

  /**
   * List all managed sandbox containers.
   */
  async listSandboxes(): Promise<SandboxInfo[]> {
    // Also check Docker for any orphaned containers with our prefix
    try {
      const { stdout } = await execAsync(
        `docker ps --filter "name=${CONTAINER_PREFIX}" --format "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.CreatedAt}}"`,
      );

      return stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, name, status, createdAt] = line.split("\t");
          return {
            id: id || "",
            status: status?.includes("Up") ? "running" : "stopped",
            region: "local",
            vcpu: 1,
            memoryMb: 512,
            diskGb: 5,
            createdAt: createdAt || "",
          };
        });
    } catch {
      return Array.from(this.containers.values()).map((c) => ({
        id: c.sandboxId,
        status: c.status,
        region: "local",
        vcpu: 1,
        memoryMb: 512,
        diskGb: 5,
        createdAt: c.createdAt,
      }));
    }
  }

  /**
   * Create a scoped sandbox executor for a specific child container.
   */
  getScopedExecutor(targetSandboxId: string): {
    exec: (command: string, timeout?: number) => Promise<ExecResult>;
    writeFile: (path: string, content: string) => Promise<void>;
    readFile: (path: string) => Promise<string>;
  } {
    const container = this.containers.get(targetSandboxId);
    if (!container) {
      throw new Error(`No managed container found for sandbox ${targetSandboxId}`);
    }

    return {
      exec: async (command: string, timeout?: number) => {
        const timeoutMs = timeout || 30_000;
        const escapedCommand = command.replace(/'/g, "'\\''");
        try {
          const { stdout, stderr } = await execAsync(
            `docker exec ${container.containerId} sh -c '${escapedCommand}'`,
            { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
          );
          return { stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
        } catch (err: any) {
          return {
            stdout: err.stdout || "",
            stderr: err.stderr || err.message || "",
            exitCode: err.code ?? 1,
          };
        }
      },
      writeFile: async (filePath: string, content: string) => {
        validatePath(filePath);
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (dir) {
          await execAsync(
            `docker exec ${container.containerId} mkdir -p '${dir}'`,
          ).catch(() => {});
        }
        const encoded = Buffer.from(content).toString("base64");
        await execAsync(
          `docker exec ${container.containerId} sh -c "echo '${encoded}' | base64 -d > '${filePath}'"`,
        );
      },
      readFile: async (filePath: string) => {
        validatePath(filePath);
        const { stdout } = await execAsync(
          `docker exec ${container.containerId} cat '${filePath}'`,
        );
        return stdout;
      },
    };
  }

  /**
   * Cleanup all managed containers. Called on shutdown.
   */
  async cleanup(): Promise<void> {
    // Clean up child containers
    for (const [id, container] of this.containers) {
      try {
        await execAsync(`docker rm -f ${container.containerId}`);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.containers.clear();

    // Clean up own sandbox container
    if (this.ownContainerId) {
      try {
        await execAsync(`docker rm -f ${this.ownContainerId}`);
        logger.info(`Cleaned up own sandbox container: ${this.ownContainerId}`);
      } catch {
        // Ignore cleanup errors
      }
      this.ownContainerId = null;
    }
  }

  private async findAvailableHostPort(): Promise<number> {
    // Find an available port on the host using Node.js net module.
    // Binds to port 0 to let the OS assign an ephemeral port, then closes the server.
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Failed to get port from server address")));
        }
      });
      server.on("error", reject);
    });
  }
}
