/**
 * Task CLI
 *
 * CLI entry point for `automaton task` mode.
 * Reads a TaskInput from stdin, runs the agent loop, and writes a
 * TaskOutput to stdout.
 *
 * Exported functions:
 *   - parseTaskArgs(argv)    — parse --max-turns, --timeout, --json
 *   - runTaskCli(argv, buildDeps) — main entry point
 */

import { parseTaskInput, serializeTaskOutput } from "./task-types.js";
import type { TaskOutput } from "./task-types.js";
import { runTask } from "./task-runner.js";
import type { TaskRunnerDeps } from "./task-runner.js";

// ─── CLI Arg Parsing ──────────────────────────────────────────────

export interface TaskCliArgs {
  maxTurns: number;
  timeoutMs: number;
  json: boolean;
}

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Parse CLI flags for the task subcommand.
 *
 *   --max-turns N   Maximum agent turns (default 25)
 *   --timeout N     Timeout in seconds (default 300, i.e. 5 minutes)
 *   --json          Output JSON to stdout (default true, flag is explicit opt-in)
 */
export function parseTaskArgs(argv: string[]): TaskCliArgs {
  let maxTurns = DEFAULT_MAX_TURNS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--max-turns" && i + 1 < argv.length) {
      const parsed = parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        maxTurns = parsed;
      }
      i++; // skip the value
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      const parsed = parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        // --timeout is specified in seconds (e.g. Paperclip sends 300 for 5 min);
        // convert to milliseconds for internal use.
        timeoutMs = parsed * 1000;
      }
      i++; // skip the value
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { maxTurns, timeoutMs, json };
}

// ─── Stdin Reader ─────────────────────────────────────────────────

/**
 * Read all of stdin as a UTF-8 string.
 * Returns an empty string if stdin is a TTY with no piped data.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);

    // If stdin is a TTY (no piped input), resolve immediately
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

// ─── Error Output Helper ──────────────────────────────────────────

function makeErrorOutput(message: string): TaskOutput {
  return {
    success: false,
    exitReason: "error",
    summary: message,
    turns: [],
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    totalCostCents: 0,
    model: "unknown",
    provider: "unknown",
    session: { turns: [], kvState: {}, workdir: null },
    survivalTier: "normal",
    creditBalance: 0,
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────

/**
 * Run the `automaton task` CLI flow:
 *
 * 1. Parse CLI args
 * 2. Read all of stdin
 * 3. Parse and validate TaskInput
 * 4. Build runtime dependencies
 * 5. Run the task
 * 6. Write TaskOutput to stdout
 * 7. Set process.exitCode
 */
export async function runTaskCli(
  argv: string[],
  buildDeps: () => Promise<TaskRunnerDeps>,
): Promise<void> {
  const args = parseTaskArgs(argv);

  // Read stdin
  let rawInput: string;
  try {
    rawInput = await readStdin();
  } catch (err) {
    const message = `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      process.stdout.write(serializeTaskOutput(makeErrorOutput(message)) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    process.exitCode = 1;
    return;
  }

  // Validate input
  if (!rawInput.trim()) {
    const message = "No input received on stdin. Pipe a JSON TaskInput to `automaton task`.";
    if (args.json) {
      process.stdout.write(serializeTaskOutput(makeErrorOutput(message)) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    process.exitCode = 1;
    return;
  }

  // Parse TaskInput
  let taskInput;
  try {
    taskInput = parseTaskInput(rawInput);
  } catch (err) {
    const message = `Invalid TaskInput: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      process.stdout.write(serializeTaskOutput(makeErrorOutput(message)) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    process.exitCode = 1;
    return;
  }

  // Build dependencies
  let deps: TaskRunnerDeps;
  try {
    deps = await buildDeps();
  } catch (err) {
    const message = `Failed to initialize runtime: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      process.stdout.write(serializeTaskOutput(makeErrorOutput(message)) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    process.exitCode = 1;
    return;
  }

  // Run the task
  let output: TaskOutput;
  try {
    output = await runTask(taskInput, deps, {
      maxTurns: args.maxTurns,
      timeoutMs: args.timeoutMs,
    });
  } catch (err) {
    const message = `Task execution failed: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      process.stdout.write(serializeTaskOutput(makeErrorOutput(message)) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    process.exitCode = 1;
    return;
  }

  // Write output
  process.stdout.write(serializeTaskOutput(output) + "\n");
  process.exitCode = output.success ? 0 : 1;
}
