import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  buildAgentOutputSchema,
  isValidTokenCount,
  parseAgentOutput,
  type Agent,
  type AgentOutput,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
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
  shutdownWindowsProcessTree,
  spawnManagedChildProcess,
} from "./managed-process.js";

interface PiAgentDeps {
  bin?: string;
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
  supervisedProcessGroup?: boolean;
}

type JsonRecord = Record<string, unknown>;

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

async function shutdownPiProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  detached: boolean,
): Promise<void> {
  if (platform === "win32") {
    return shutdownWindowsProcessTree(child);
  }

  await shutdownChildProcess(child, { detached });
}

function buildPiPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant response must be only valid JSON matching this JSON Schema. Do not wrap it in Markdown fences. Do not include prose before or after the JSON object.

${JSON.stringify(schema, null, 2)}`;
}

function buildPiArgs(extraArgs?: string[]): string[] {
  return [...(extraArgs ?? []), "--mode", "json", "--no-session"];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function numberField(record: JsonRecord, names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function toTokenUsage(usage: JsonRecord | undefined): TokenUsage | null {
  if (!usage) return null;

  const inputTokens = numberField(usage, ["input"]);
  const outputTokens = numberField(usage, ["output"]);
  const totalTokens = numberField(usage, ["totalTokens", "total_tokens"]);
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  const reportedCostUsd = cost ? numberField(cost, ["total"]) : undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: numberField(usage, ["cacheRead"]) ?? 0,
    cacheCreationTokens: numberField(usage, ["cacheWrite"]) ?? 0,
    ...(isValidTokenCount(totalTokens) ? { totalTokens } : {}),
    ...(isValidTokenCount(reportedCostUsd) ? { reportedCostUsd } : {}),
    tokensAvailable:
      isValidTokenCount(inputTokens) && isValidTokenCount(outputTokens),
  };
}

function isSameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.totalTokens === b.totalTokens &&
    a.reportedCostUsd === b.reportedCostUsd &&
    a.tokensAvailable === b.tokensAvailable
  );
}

function messageKey(message: JsonRecord): string | null {
  const responseId = stringField(message, ["responseId", "id"]);
  if (responseId) return responseId;

  const timestamp = message.timestamp;
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    return `timestamp:${timestamp}`;
  }

  return null;
}

function roleOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.role === "string"
    ? message.role
    : undefined;
}

function textFromContentBlock(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return null;
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return null;
}

function textFromAssistantMessage(message: JsonRecord | null): string {
  if (!message) return "";

  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(textFromContentBlock)
      .filter((text): text is string => text !== null)
      .join("");
  }

  return "";
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textByIndexToString(textByIndex: Map<number, string>): string {
  return [...textByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("");
}

export class PiAgent implements Agent {
  name = "pi";

  private activeChild: ReturnType<typeof spawn> | null = null;
  private bin: string;
  private detached: boolean;
  private extraArgs?: string[];
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;
  private shutdowns = new ChildProcessShutdownTracker();

  constructor(deps: PiAgentDeps = {}) {
    this.bin = deps.bin ?? "pi";
    this.extraArgs = deps.extraArgs;
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
        buildPiArgs(this.extraArgs),
        {
          cwd,
          detached: this.detached,
          shell: shouldUseWindowsShell(this.bin, this.platform),
          stdio: ["pipe", "pipe", "pipe"],
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
          shutdownPiProcess(child, this.platform, this.detached),
        );
      const shutdownRun = () =>
        this.shutdowns.start(() =>
          shutdownPiProcess(child, this.platform, this.detached),
        );

      child.stdin?.write(buildPiPrompt(prompt, this.schema));
      child.stdin?.end();

      if (setupAbortHandler(signal, child, reject, shutdownRun)) {
        return;
      }

      let latestAssistantMessage: JsonRecord | null = null;
      const streamTextByIndex = new Map<number, string>();
      const completeTextByIndex = new Map<number, string>();
      const usageByMessageKey = new Map<string, TokenUsage>();
      let lastEmittedUsage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokensAvailable: false,
      };
      let anonymousKeySeq = 0;
      let currentStreamingMessageKey: string | null = null;

      const updateUsage = (
        message: JsonRecord | null,
        streaming = false,
        requireReceipt = false,
        usageOverride?: JsonRecord,
      ) => {
        const usage = toTokenUsage(
          usageOverride ??
            (message !== null && isRecord(message.usage)
              ? message.usage
              : undefined),
        );
        if (!usage && !requireReceipt) return;

        let key = streaming ? currentStreamingMessageKey : null;
        if (key === null && message !== null) {
          key = messageKey(message);
        }
        if (key === null) {
          key = `assistant-anonymous-${anonymousKeySeq++}`;
        }
        if (streaming) currentStreamingMessageKey = key;
        usageByMessageKey.set(
          key,
          usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            tokensAvailable: false,
          },
        );

        const cumulative: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          tokensAvailable: false,
        };
        for (const entry of usageByMessageKey.values()) {
          cumulative.inputTokens += entry.inputTokens;
          cumulative.outputTokens += entry.outputTokens;
          cumulative.cacheReadTokens += entry.cacheReadTokens;
          cumulative.cacheCreationTokens += entry.cacheCreationTokens;
        }
        const usageReceipts = [...usageByMessageKey.values()];
        cumulative.tokensAvailable = usageReceipts.every(
          (entry) => entry.tokensAvailable,
        );
        delete cumulative.totalTokens;
        delete cumulative.reportedCostUsd;
        if (
          usageReceipts.every((entry) => isValidTokenCount(entry.totalTokens))
        ) {
          cumulative.totalTokens = usageReceipts.reduce(
            (total, entry) => total + entry.totalTokens!,
            0,
          );
        }
        if (
          usageReceipts.every((entry) =>
            isValidTokenCount(entry.reportedCostUsd),
          )
        ) {
          cumulative.reportedCostUsd = usageReceipts.reduce(
            (total, entry) => total + entry.reportedCostUsd!,
            0,
          );
        }

        if (!isSameUsage(cumulative, lastEmittedUsage)) {
          lastEmittedUsage = cumulative;
          onUsage?.({ ...cumulative });
        }
      };

      const rememberAssistantMessage = (
        message: unknown,
        streaming = false,
        requireReceipt = false,
        usageOverride?: JsonRecord,
      ) => {
        if (!isRecord(message) || roleOf(message) !== "assistant") return;
        latestAssistantMessage = message;
        if (streaming) {
          currentStreamingMessageKey =
            currentStreamingMessageKey ??
            messageKey(message) ??
            `assistant-anonymous-${anonymousKeySeq++}`;
        }
        updateUsage(message, streaming, requireReceipt, usageOverride);
      };

      parseJSONLStream<JsonRecord>(child.stdout!, logStream, (event) => {
        if (!isRecord(event)) return;

        if (event.type === "message_start") {
          if (
            isRecord(event.message) &&
            roleOf(event.message) === "assistant"
          ) {
            currentStreamingMessageKey =
              messageKey(event.message) ??
              currentStreamingMessageKey ??
              `assistant-anonymous-${anonymousKeySeq++}`;
            updateUsage(event.message, true);
          }
        }

        if (event.type === "message_update") {
          const liveUsage = isRecord(event.usage) ? event.usage : undefined;
          if (isRecord(event.message)) {
            rememberAssistantMessage(event.message, true, false, liveUsage);
          } else if (liveUsage !== undefined) {
            updateUsage(null, true, false, liveUsage);
          }

          if (isRecord(event.assistantMessageEvent)) {
            const assistantEvent = event.assistantMessageEvent;
            const contentIndex =
              numberField(assistantEvent, ["contentIndex", "content_index"]) ??
              0;

            if (assistantEvent.type === "text_delta") {
              const delta = stringField(assistantEvent, [
                "delta",
                "text",
                "content",
              ]);
              if (delta) {
                const next =
                  (streamTextByIndex.get(contentIndex) ?? "") + delta;
                streamTextByIndex.set(contentIndex, next);
                const visible = next.trim();
                if (visible) onMessage?.(visible);
              }
            }

            if (assistantEvent.type === "text_end") {
              const text =
                stringField(assistantEvent, ["text", "content"]) ??
                streamTextByIndex.get(contentIndex) ??
                "";
              completeTextByIndex.set(contentIndex, text);
              const visible = text.trim();
              if (visible) onMessage?.(visible);
            }
          }
        }

        if (event.type === "message_end" || event.type === "turn_end") {
          rememberAssistantMessage(event.message, true, true);
          currentStreamingMessageKey = null;
        }

        if (
          event.type === "agent_end" &&
          Array.isArray(event.messages) &&
          !latestAssistantMessage
        ) {
          for (const message of event.messages) {
            if (roleOf(message) === "assistant") {
              rememberAssistantMessage(message, false, true);
            }
          }
        }
      });

      setupChildProcessHandlers(
        child,
        "pi",
        logStream,
        reject,
        () => {
          if (latestAssistantMessage) {
            const stopReason = latestAssistantMessage.stopReason;
            if (stopReason === "error" || stopReason === "aborted") {
              const errorMessage =
                stringField(latestAssistantMessage, [
                  "errorMessage",
                  "error",
                  "message",
                ]) ?? compactJson(latestAssistantMessage);
              reject(new Error(`pi reported error: ${errorMessage}`));
              return;
            }
          }

          const finalText =
            textFromAssistantMessage(latestAssistantMessage).trim() ||
            textByIndexToString(completeTextByIndex).trim() ||
            textByIndexToString(streamTextByIndex).trim();

          if (!finalText) {
            reject(new Error("pi returned no text output"));
            return;
          }

          let output: AgentOutput;
          try {
            output = parseAgentOutput(finalText, this.schema, "pi");
          } catch (err) {
            const message =
              err instanceof SyntaxError
                ? `Failed to parse pi output: ${err.message}`
                : `Invalid pi output: ${err instanceof Error ? err.message : err}`;
            reject(new Error(message));
            return;
          }

          resolve({ output, usage: lastEmittedUsage });
        },
        { finalize: finalizeRun, shutdown: shutdownRun },
      );
    });
  }

  async close(): Promise<void> {
    const activeChild = this.activeChild;
    if (activeChild !== null) {
      this.shutdowns.start(() =>
        shutdownPiProcess(activeChild, this.platform, this.detached),
      );
    }
    await this.shutdowns.waitForAll();
  }
}
