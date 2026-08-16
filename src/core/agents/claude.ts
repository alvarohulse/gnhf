import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  buildAgentOutputSchema,
  isValidTokenCount,
  type Agent,
  type AgentOutput,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
  PermanentAgentError,
} from "./types.js";
import {
  ChildProcessShutdownTracker,
  shouldDetachAgentProcess,
  shutdownChildProcess,
  shutdownWindowsProcessTree,
  spawnManagedChildProcess,
} from "./managed-process.js";
import { parseJSONLStream, setupAbortHandler } from "./stream-utils.js";

const DEFAULT_FINAL_RESULT_EXIT_GRACE_MS = 15_000;
/** Upper bound on the stdout tail kept for non-zero-exit error reporting. */
const MAX_EXIT_OUTPUT_CHARS = 4_000;
/**
 * Tighter bound on unstructured stdout quoted back in the failure detail: that
 * text lands in notes.md and is replayed in every later iteration prompt.
 */
const MAX_RAW_TAIL_CHARS = 400;
const RAW_TAIL_ELISION = "[...truncated, full output in the iteration log] ";

interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    id?: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ClaudeResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  structured_output: AgentOutput | null;
}

type ClaudeEvent = ClaudeAssistantEvent | ClaudeResultEvent | { type: string };

interface ClaudeAgentDeps {
  bin?: string;
  extraArgs?: string[];
  finalResultGraceMs?: number;
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
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

async function shutdownClaudeProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  detached: boolean,
): Promise<void> {
  if (platform === "win32") {
    return shutdownWindowsProcessTree(child);
  }

  await shutdownChildProcess(child, {
    detached,
  });
}

function isFinalStructuredResult(event: ClaudeResultEvent): boolean {
  return (
    !event.is_error && event.subtype === "success" && !!event.structured_output
  );
}

function buildClaudeArgs(
  prompt: string,
  schema: AgentOutputSchema,
  extraArgs?: string[],
): string[] {
  const userArgs = extraArgs ?? [];
  const userSpecifiedPermissionMode = userArgs.some(
    (arg) =>
      arg === "--dangerously-skip-permissions" ||
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=") ||
      arg === "--permission-prompt-tool" ||
      arg.startsWith("--permission-prompt-tool="),
  );

  return [
    ...userArgs,
    "-p",
    prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(schema),
    ...(userSpecifiedPermissionMode ? [] : ["--dangerously-skip-permissions"]),
  ];
}

function toTokenUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): TokenUsage {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const tokensAvailable =
    isValidTokenCount(inputTokens) && isValidTokenCount(outputTokens);
  const normalizedInputTokens = (inputTokens ?? 0) + cacheReadTokens;
  return {
    inputTokens: normalizedInputTokens,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens,
    ...(tokensAvailable
      ? {
          totalTokens:
            normalizedInputTokens + (outputTokens ?? 0) + cacheCreationTokens,
        }
      : {}),
    tokensAvailable,
  };
}

function toResultUsage(event: ClaudeResultEvent): TokenUsage | null {
  const inputTokens = event.usage?.input_tokens;
  const outputTokens = event.usage?.output_tokens;
  const cacheReadTokens = event.usage?.cache_read_input_tokens;
  const cacheCreationTokens = event.usage?.cache_creation_input_tokens;
  const reportedCostUsd = event.total_cost_usd;
  const tokensAvailable =
    isValidTokenCount(inputTokens) && isValidTokenCount(outputTokens);
  const reportedCostAvailable = isValidTokenCount(reportedCostUsd);

  if (!tokensAvailable && !reportedCostAvailable) {
    return null;
  }

  return {
    inputTokens: tokensAvailable
      ? inputTokens + (isValidTokenCount(cacheReadTokens) ? cacheReadTokens : 0)
      : 0,
    outputTokens: tokensAvailable ? outputTokens : 0,
    cacheReadTokens: isValidTokenCount(cacheReadTokens) ? cacheReadTokens : 0,
    cacheCreationTokens: isValidTokenCount(cacheCreationTokens)
      ? cacheCreationTokens
      : 0,
    ...(tokensAvailable
      ? {
          totalTokens:
            inputTokens +
            outputTokens +
            (isValidTokenCount(cacheReadTokens) ? cacheReadTokens : 0) +
            (isValidTokenCount(cacheCreationTokens) ? cacheCreationTokens : 0),
        }
      : {}),
    ...(reportedCostAvailable ? { reportedCostUsd } : {}),
    tokensAvailable,
  };
}

function isSameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.tokensAvailable === b.tokensAvailable
  );
}

function extendsUsage(next: TokenUsage, previous: TokenUsage): boolean {
  return (
    next.inputTokens >= previous.inputTokens &&
    next.outputTokens >= previous.outputTokens &&
    next.cacheReadTokens >= previous.cacheReadTokens &&
    next.cacheCreationTokens >= previous.cacheCreationTokens &&
    !isSameUsage(next, previous)
  );
}

function isPermanentClaudeError(output: string): boolean {
  return /credit balance\s+is\s+too\s+low/i.test(output);
}

/** Keep only the last `MAX_EXIT_OUTPUT_CHARS` characters so long streams stay bounded. */
function appendBoundedTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length > MAX_EXIT_OUTPUT_CHARS
    ? combined.slice(combined.length - MAX_EXIT_OUTPUT_CHARS)
    : combined;
}

function errorTextFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  if (record.is_error === true || record.type === "error") {
    for (const key of ["result", "message", "subtype"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  return null;
}

/** Quote only the end of unstructured output, marking what was dropped. */
function elideRawTail(raw: string): string {
  return raw.length > MAX_RAW_TAIL_CHARS
    ? `${RAW_TAIL_ELISION}${raw.slice(raw.length - MAX_RAW_TAIL_CHARS)}`
    : raw;
}

interface StdoutFailure {
  /** Error text the CLI itself authored in structured stdout events. */
  structured: string;
  /** Text worth reporting: the structured text, or a short raw tail. */
  reported: string;
}

/**
 * Pull the CLI's own error text out of its stdout, which is JSONL when the run
 * got far enough to stream events and plain text otherwise. Falls back to a
 * bounded raw tail so the reported detail is never empty when stdout had
 * content.
 */
function extractStdoutError(stdoutTail: string): StdoutFailure {
  const messages: string[] = [];
  for (const line of stdoutTail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = errorTextFromEvent(JSON.parse(line));
      if (message) messages.push(message);
    } catch {
      // Not JSON: covered by the raw-tail fallback below.
    }
  }
  const structured = messages.join("\n");
  return {
    structured,
    reported: structured || elideRawTail(stdoutTail.trim()),
  };
}

interface ExitFailure {
  detail: string;
  permanent: boolean;
}

/**
 * Describe a non-zero exit. `detail` reports everything both streams offered,
 * while `permanent` is decided only from text the CLI itself authored - stderr
 * and structured stdout error fields - so agent output that merely quotes a
 * permanent-failure phrase cannot abort an otherwise retryable run.
 */
function describeExitFailure(
  code: number | null,
  stdoutTail: string,
  stderr: string,
): ExitFailure {
  const trimmedStderr = stderr.trim();
  const stdoutError = extractStdoutError(stdoutTail);
  const segments = [trimmedStderr, stdoutError.reported].filter(Boolean);
  return {
    detail:
      segments.length > 0
        ? `claude exited with code ${code}: ${segments.join("\n")}`
        : `claude exited with code ${code} and produced no output`,
    permanent: isPermanentClaudeError(
      [trimmedStderr, stdoutError.structured].filter(Boolean).join("\n"),
    ),
  };
}

export class ClaudeAgent implements Agent {
  name = "claude";

  private activeChild: ReturnType<typeof spawn> | null = null;
  private bin: string;
  private extraArgs?: string[];
  private finalResultGraceMs: number;
  private detached: boolean;
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;
  private shutdowns = new ChildProcessShutdownTracker();

  constructor(binOrDeps: string | ClaudeAgentDeps = {}) {
    const deps = typeof binOrDeps === "string" ? { bin: binOrDeps } : binOrDeps;
    this.bin = deps.bin ?? "claude";
    this.extraArgs = deps.extraArgs;
    this.finalResultGraceMs =
      deps.finalResultGraceMs ?? DEFAULT_FINAL_RESULT_EXIT_GRACE_MS;
    this.platform = deps.platform ?? process.platform;
    this.detached = shouldDetachAgentProcess(
      this.platform,
      deps.supervisedProcessGroup,
    );
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;

      const child = spawnManagedChildProcess(
        spawn,
        this.bin,
        buildClaudeArgs(prompt, this.schema, this.extraArgs),
        {
          cwd,
          detached: this.detached,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
        this.shutdowns,
        this.platform,
      );
      this.activeChild = child;
      child.on("close", () => {
        if (this.activeChild === child) {
          this.activeChild = null;
        }
      });
      const finalizeRun = () =>
        this.shutdowns.finalizeOwnedProcessGroup(child, this.detached, () =>
          shutdownClaudeProcess(child, this.platform, this.detached),
        );
      const shutdownRun = () =>
        this.shutdowns.start(() =>
          shutdownClaudeProcess(child, this.platform, this.detached),
        );
      const rejectCleanupFailure = (error: unknown) => {
        reject(
          error instanceof Error
            ? error
            : new Error(`Claude process cleanup failed: ${String(error)}`),
        );
      };
      const rejectAfterShutdown = (error: Error) => {
        void (async () => {
          try {
            await shutdownRun();
            reject(error);
          } catch (cleanupError) {
            rejectCleanupFailure(cleanupError);
          }
        })();
      };

      if (setupAbortHandler(signal, child, reject, shutdownRun)) {
        return;
      }

      let resultEvent: ClaudeResultEvent | null = null;
      let finalStructuredResultEvent: ClaudeResultEvent | null = null;
      let latestResultUsage: TokenUsage | null = null;
      let finalResultCleanupTimer: ReturnType<typeof setTimeout> | null = null;
      let closedAfterFinalCleanup = false;
      let stderr = "";
      let stdoutTail = "";
      const cumulative: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokensAvailable: false,
      };
      const usageByMessageId = new Map<string, TokenUsage>();
      let anonymousAssistantCount = 0;
      let lastAnonymousAssistantId: string | null = null;
      let lastAnonymousAssistantUsage: TokenUsage | null = null;
      let pendingAnonymousAssistantUsage: TokenUsage | null = null;

      const getResultUsage = (): TokenUsage => {
        if (latestResultUsage !== null) {
          return latestResultUsage;
        }
        latestResultUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          tokensAvailable: false,
        };
        onUsage?.({ ...latestResultUsage });
        return latestResultUsage;
      };

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdout!.on("data", (data: Buffer) => {
        stdoutTail = appendBoundedTail(stdoutTail, data.toString());
      });

      child.on("error", (err) => {
        rejectAfterShutdown(
          new Error(`Failed to spawn claude: ${err.message}`),
        );
      });

      parseJSONLStream<ClaudeEvent>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const msg = (event as ClaudeAssistantEvent).message;
          const nextUsage = toTokenUsage(msg.usage);
          let messageId = msg.id;
          let previousUsage: TokenUsage | undefined;

          if (messageId) {
            previousUsage = usageByMessageId.get(messageId);
            lastAnonymousAssistantId = null;
            lastAnonymousAssistantUsage = null;
            pendingAnonymousAssistantUsage = null;
          } else if (
            pendingAnonymousAssistantUsage &&
            extendsUsage(nextUsage, pendingAnonymousAssistantUsage)
          ) {
            messageId = `assistant-${anonymousAssistantCount++}`;
            previousUsage = pendingAnonymousAssistantUsage;
            cumulative.inputTokens +=
              pendingAnonymousAssistantUsage.inputTokens;
            cumulative.outputTokens +=
              pendingAnonymousAssistantUsage.outputTokens;
            cumulative.cacheReadTokens +=
              pendingAnonymousAssistantUsage.cacheReadTokens;
            cumulative.cacheCreationTokens +=
              pendingAnonymousAssistantUsage.cacheCreationTokens;
            usageByMessageId.set(messageId, pendingAnonymousAssistantUsage);
            pendingAnonymousAssistantUsage = null;
            lastAnonymousAssistantId = messageId;
            lastAnonymousAssistantUsage = nextUsage;
          } else if (
            lastAnonymousAssistantId &&
            lastAnonymousAssistantUsage &&
            extendsUsage(nextUsage, lastAnonymousAssistantUsage)
          ) {
            messageId = lastAnonymousAssistantId;
            previousUsage = usageByMessageId.get(messageId);
            pendingAnonymousAssistantUsage = null;
            lastAnonymousAssistantUsage = nextUsage;
          } else if (
            lastAnonymousAssistantId &&
            lastAnonymousAssistantUsage &&
            isSameUsage(nextUsage, lastAnonymousAssistantUsage)
          ) {
            messageId = lastAnonymousAssistantId;
            previousUsage = usageByMessageId.get(messageId);
            pendingAnonymousAssistantUsage ??= nextUsage;
          } else {
            messageId = `assistant-${anonymousAssistantCount++}`;
            pendingAnonymousAssistantUsage = null;
            lastAnonymousAssistantId = messageId;
            lastAnonymousAssistantUsage = nextUsage;
          }

          if (previousUsage) {
            cumulative.inputTokens +=
              nextUsage.inputTokens - previousUsage.inputTokens;
            cumulative.outputTokens +=
              nextUsage.outputTokens - previousUsage.outputTokens;
            cumulative.cacheReadTokens +=
              nextUsage.cacheReadTokens - previousUsage.cacheReadTokens;
            cumulative.cacheCreationTokens +=
              nextUsage.cacheCreationTokens - previousUsage.cacheCreationTokens;
          } else {
            cumulative.inputTokens += nextUsage.inputTokens;
            cumulative.outputTokens += nextUsage.outputTokens;
            cumulative.cacheReadTokens += nextUsage.cacheReadTokens;
            cumulative.cacheCreationTokens += nextUsage.cacheCreationTokens;
          }

          usageByMessageId.set(messageId, nextUsage);
          cumulative.tokensAvailable = [...usageByMessageId.values()].every(
            (usage) => usage.tokensAvailable,
          );
          if (cumulative.tokensAvailable) {
            cumulative.totalTokens =
              cumulative.inputTokens +
              cumulative.outputTokens +
              cumulative.cacheCreationTokens;
          } else {
            delete cumulative.totalTokens;
          }
          onUsage?.({ ...cumulative });

          if (onMessage) {
            const content = (msg as Record<string, unknown>).content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block?.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.trim()
                ) {
                  onMessage(block.text.trim());
                }
              }
            }
          }
        }

        if (event.type === "result") {
          const next = event as ClaudeResultEvent;
          const nextUsage = toResultUsage(next) ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            tokensAvailable: false,
          };
          latestResultUsage = nextUsage;
          onUsage?.({ ...nextUsage });
          if (isFinalStructuredResult(next)) {
            finalStructuredResultEvent = next;
            if (finalResultCleanupTimer) {
              clearTimeout(finalResultCleanupTimer);
            }
            finalResultCleanupTimer = setTimeout(() => {
              closedAfterFinalCleanup = true;
              void shutdownRun().catch(rejectCleanupFailure);
            }, this.finalResultGraceMs);
          } else if (
            !finalStructuredResultEvent &&
            (next.is_error ||
              next.subtype !== "success" ||
              next.structured_output ||
              !resultEvent)
          ) {
            resultEvent = next;
          }
        }
      });

      child.on("close", async (code) => {
        if (finalResultCleanupTimer) {
          clearTimeout(finalResultCleanupTimer);
        }
        logStream?.end();
        try {
          await finalizeRun();
          if (closedAfterFinalCleanup) {
            await this.shutdowns.waitForAll();
          }
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error(`Claude process cleanup failed: ${String(error)}`),
          );
          return;
        }
        const terminalUsage = getResultUsage();
        if (code !== 0 && !closedAfterFinalCleanup) {
          const failure = describeExitFailure(code, stdoutTail, stderr);
          reject(
            failure.permanent
              ? new PermanentAgentError(
                  "claude credit balance too low - see gnhf.log",
                  failure.detail,
                )
              : new Error(failure.detail),
          );
          return;
        }

        const terminalResultEvent = finalStructuredResultEvent ?? resultEvent;

        if (!terminalResultEvent) {
          reject(new Error("claude returned no result event"));
          return;
        }

        if (
          terminalResultEvent.is_error ||
          terminalResultEvent.subtype !== "success"
        ) {
          reject(
            new Error(
              `claude reported error: ${JSON.stringify(terminalResultEvent)}`,
            ),
          );
          return;
        }

        if (!terminalResultEvent.structured_output) {
          reject(new Error("claude returned no structured_output"));
          return;
        }

        const output: AgentOutput = terminalResultEvent.structured_output;
        resolve({ output, usage: terminalUsage });
      });
    });
  }

  async close(): Promise<void> {
    const activeChild = this.activeChild;
    if (activeChild !== null) {
      this.shutdowns.start(() =>
        shutdownClaudeProcess(activeChild, this.platform, this.detached),
      );
    }
    await this.shutdowns.waitForAll();
  }
}
