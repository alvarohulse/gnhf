import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  isValidTokenCount,
  type Agent,
  type AgentResult,
  type AgentOutput,
  type TokenUsage,
  type AgentRunOptions,
} from "./types.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";
import {
  ChildProcessShutdownTracker,
  shouldDetachAgentProcess,
  shutdownChildProcess,
} from "./managed-process.js";

interface CodexItemCompleted {
  type: "item.completed";
  item: { type: string; text: string };
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

type CodexEvent = CodexItemCompleted | CodexTurnCompleted | { type: string };

interface CodexAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  supervisedProcessGroup?: boolean;
}

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminateCodexProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  child.kill("SIGTERM");
}

async function shutdownCodexProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  detached: boolean,
): Promise<void> {
  if (platform === "win32") {
    terminateCodexProcess(child, platform);
    return;
  }

  await shutdownChildProcess(child, { detached });
}

function buildCodexArgs(
  prompt: string,
  schemaPath: string,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];
  const userSpecifiedExecutionMode = userArgs.some(
    (arg) =>
      arg === "--full-auto" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--sandbox" ||
      arg.startsWith("--sandbox=") ||
      arg === "-s" ||
      arg === "--ask-for-approval" ||
      arg.startsWith("--ask-for-approval=") ||
      arg === "-a",
  );

  return [
    "exec",
    ...userArgs,
    prompt,
    "--json",
    "--output-schema",
    schemaPath,
    ...(userSpecifiedExecutionMode
      ? []
      : ["--dangerously-bypass-approvals-and-sandbox"]),
    "--color",
    "never",
  ];
}

export class CodexAgent implements Agent {
  name = "codex";

  private activeChild: ReturnType<typeof spawn> | null = null;
  private bin: string;
  private detached: boolean;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schemaPath: string;
  private shutdowns = new ChildProcessShutdownTracker();

  constructor(schemaPath: string, binOrDeps: string | CodexAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "codex";
    this.extraArgs = deps.extraArgs;
    this.platform = deps.platform ?? process.platform;
    this.detached = shouldDetachAgentProcess(
      this.platform,
      deps.supervisedProcessGroup,
    );
    this.schemaPath = schemaPath;
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawn(
        this.bin,
        buildCodexArgs(prompt, this.schemaPath, this.extraArgs),
        {
          cwd,
          detached: this.detached,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      this.activeChild = child;
      child.on("close", () => {
        if (this.activeChild === child) {
          this.activeChild = null;
        }
      });

      if (
        setupAbortHandler(signal, child, reject, () => {
          void this.shutdowns.start(() =>
            shutdownCodexProcess(child, this.platform, this.detached),
          );
        })
      ) {
        return;
      }

      let lastAgentMessage: string | null = null;
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokensAvailable: false,
      };
      let incompleteUsageObserved = false;
      let usageEventCount = 0;

      parseJSONLStream<CodexEvent>(child.stdout!, logStream, (event) => {
        if (
          event.type === "item.completed" &&
          "item" in event &&
          (event as CodexItemCompleted).item.type === "agent_message"
        ) {
          lastAgentMessage = (event as CodexItemCompleted).item.text;
          onMessage?.(lastAgentMessage);
        }

        if (event.type === "turn.completed" && "usage" in event) {
          const u = (event as CodexTurnCompleted).usage;
          usageEventCount += 1;
          const eventTokensAvailable =
            isValidTokenCount(u.input_tokens) &&
            isValidTokenCount(u.output_tokens);
          incompleteUsageObserved ||= !eventTokensAvailable;
          cumulative.inputTokens += isValidTokenCount(u.input_tokens)
            ? u.input_tokens
            : 0;
          cumulative.outputTokens += isValidTokenCount(u.output_tokens)
            ? u.output_tokens
            : 0;
          cumulative.cacheReadTokens += isValidTokenCount(u.cached_input_tokens)
            ? u.cached_input_tokens
            : 0;
          cumulative.tokensAvailable =
            usageEventCount > 0 && !incompleteUsageObserved;
          onUsage?.({ ...cumulative });
        }
      });

      setupChildProcessHandlers(child, "codex", logStream, reject, () => {
        if (!lastAgentMessage) {
          reject(new Error("codex returned no agent message"));
          return;
        }

        try {
          const output = JSON.parse(lastAgentMessage) as AgentOutput;
          resolve({ output, usage: cumulative });
        } catch (err) {
          reject(
            new Error(
              `Failed to parse codex output: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
      });
    });
  }

  async close(): Promise<void> {
    const activeChild = this.activeChild;
    if (activeChild !== null) {
      this.shutdowns.start(() =>
        shutdownCodexProcess(activeChild, this.platform, this.detached),
      );
    }
    await this.shutdowns.waitForAll();
  }
}
