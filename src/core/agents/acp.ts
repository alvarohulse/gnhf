import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeTurnResult,
  type AcpxRuntime,
} from "acpx/runtime";
import { appendDebugLog, serializeError } from "../debug-log.js";
import { redactAcpTargetForLogs } from "../config.js";
import { parseAgentJson } from "./json-extract.js";
import {
  IncompleteAgentShutdownError,
  PermanentAgentError,
  validateAgentOutput,
  type Agent,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
} from "./types.js";

/**
 * Subset of `AcpxRuntime` that AcpAgent depends on. Declared here so tests
 * can stub the runtime without pulling in the real acpx implementation.
 */
type AcpxRuntimeLike = Pick<
  AcpxRuntime,
  "ensureSession" | "startTurn" | "close"
>;

export interface AcpAgentDeps {
  target: string;
  schema: AgentOutputSchema;
  runId: string;
  sessionStateDir: string;
  registryOverrides?: Record<string, string>;
  runtimeFactory?: (options: AcpRuntimeOptions) => AcpxRuntimeLike;
}

function buildAcpPrompt(prompt: string, schema: AgentOutputSchema): string {
  return `${prompt}

## gnhf final output contract

When the iteration is complete, your final assistant message must be a single JSON object that matches this JSON Schema. Return only the JSON object. Do not wrap it in Markdown fences. Do not include prose before or after the JSON.

${JSON.stringify(schema, null, 2)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "Agent was aborted")
  );
}

function createAbortError(): Error {
  return new Error("Agent was aborted");
}

function redactRawAcpTargetInString(text: string, target: string): string {
  const redacted = redactAcpTargetForLogs(target);
  if (redacted === target) return text;
  return text.split(target).join(redacted);
}

function redactRawAcpTargetInValue(value: unknown, target: string): unknown {
  if (typeof value === "string") {
    return redactRawAcpTargetInString(value, target);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRawAcpTargetInValue(item, target));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactRawAcpTargetInValue(entry, target),
      ]),
    );
  }
  return value;
}

function serializeAcpErrorForLog(
  error: unknown,
  target: string,
): Record<string, unknown> {
  return redactRawAcpTargetInValue(serializeError(error), target) as Record<
    string,
    unknown
  >;
}

function redactAcpErrorForThrow(error: unknown, target: string): unknown {
  const redacted = redactAcpTargetForLogs(target);
  if (redacted === target) return error;
  if (error instanceof PermanentAgentError) {
    return new PermanentAgentError(
      redactRawAcpTargetInString(error.message, target),
      redactRawAcpTargetInString(error.detail, target),
    );
  }
  if (error instanceof Error) {
    let cause: unknown;
    try {
      cause = "cause" in error ? error.cause : undefined;
    } catch {
      cause = undefined;
    }
    const redactedCause =
      cause === undefined ? undefined : redactAcpErrorForThrow(cause, target);
    const redactedError = new Error(
      redactRawAcpTargetInString(error.message, target),
      redactedCause === undefined ? undefined : { cause: redactedCause },
    );
    redactedError.name = error.name;
    if (typeof error.stack === "string") {
      redactedError.stack = redactRawAcpTargetInString(error.stack, target);
    }
    const code = (error as { code?: unknown }).code;
    if (code !== undefined) {
      (redactedError as { code?: unknown }).code = code;
    }
    return redactedError;
  }
  return redactRawAcpTargetInValue(error, target);
}

export class AcpAgent implements Agent {
  readonly name: string;

  private readonly target: string;
  private readonly schema: AgentOutputSchema;
  private readonly runId: string;
  private readonly sessionStateDir: string;
  private readonly registryOverrides: Record<string, string> | undefined;
  private readonly runtimeFactory: (
    options: AcpRuntimeOptions,
  ) => AcpxRuntimeLike;

  private runtime: AcpxRuntimeLike | null = null;
  private handle: AcpRuntimeHandle | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;

  constructor(deps: AcpAgentDeps) {
    this.target = deps.target;
    this.schema = deps.schema;
    this.runId = deps.runId;
    this.sessionStateDir = deps.sessionStateDir;
    this.registryOverrides = deps.registryOverrides;
    this.runtimeFactory =
      deps.runtimeFactory ?? ((options) => createAcpRuntime(options));
    this.name = `acp:${deps.target}`;
  }

  async run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    if (this.closed) {
      throw new Error("AcpAgent has been closed");
    }

    const { signal, onMessage, logPath } = options ?? {};
    if (signal?.aborted) {
      throw createAbortError();
    }

    const runtime = this.ensureRuntime(cwd);
    let handle: AcpRuntimeHandle;
    try {
      handle = await runtime.ensureSession({
        sessionKey: this.runId,
        agent: this.target,
        mode: "persistent",
        cwd,
      });
    } catch (error) {
      throw redactAcpErrorForThrow(error, this.target);
    }
    this.handle = handle;

    const requestId = randomUUID();
    appendDebugLog("acp:turn:start", {
      target: redactAcpTargetForLogs(this.target),
      sessionKey: this.runId,
      requestId,
      cwd,
    });

    const acpPrompt = buildAcpPrompt(prompt, this.schema);

    const startedAt = Date.now();
    const turn = (() => {
      try {
        return runtime.startTurn({
          handle,
          text: acpPrompt,
          mode: "prompt",
          requestId,
          signal,
        });
      } catch (error) {
        appendDebugLog("acp:turn:start-error", {
          target: redactAcpTargetForLogs(this.target),
          requestId,
          elapsedMs: Date.now() - startedAt,
          error: serializeAcpErrorForLog(error, this.target),
        });
        throw redactAcpErrorForThrow(error, this.target);
      }
    })();
    // Buffer for the in-flight assistant message. ACP adapters stream
    // `agent_message_chunk` notifications as many tiny `text_delta` events
    // (often a few characters each). We accumulate them and only surface the
    // message via `onMessage` when the message is complete - on a tool_call
    // boundary, a stream change, or end of turn.
    let pendingMessage = "";
    let pendingStream: "output" | "thought" | null = null;
    // The most recently completed output-stream message. The agent's final
    // structured JSON answer is supposed to be the last assistant message of
    // the turn, so this is the primary candidate to JSON.parse - separating
    // it from intermediate prose like "Let me examine the code...".
    let lastOutputMessage = "";
    // Concatenation of every output-stream chunk in the turn, used as a
    // fallback when `lastOutputMessage` doesn't parse (e.g. when the agent
    // streams the entire response as one continuous message without any
    // tool_call to break it up).
    let outputBuf = "";
    const logStream = logPath ? createWriteStream(logPath) : null;

    const flushPendingMessage = () => {
      if (pendingMessage.length > 0) {
        if (pendingStream === "output") {
          lastOutputMessage = pendingMessage;
        }
        onMessage?.(pendingMessage);
        pendingMessage = "";
      }
      pendingStream = null;
    };

    try {
      try {
        for await (const event of turn.events) {
          logStream?.write(`${JSON.stringify(event)}\n`);

          if (event.type === "text_delta") {
            const stream = event.stream ?? "output";
            const text = event.text;
            if (!text) continue;
            if (pendingStream !== null && pendingStream !== stream) {
              flushPendingMessage();
            }
            pendingStream = stream;
            pendingMessage += text;
            if (stream === "output") {
              outputBuf += text;
            }
            continue;
          }

          if (event.type === "tool_call") {
            // A tool_call ends the in-flight assistant message - flush
            // whatever prose the assistant streamed so far, but don't surface
            // the tool_call text itself. Tool descriptions like
            // "tool call (completed)" are noisy and not useful in the TUI;
            // the user wants to see assistant prose, not mechanics.
            flushPendingMessage();
            continue;
          }

          if (event.type === "status") {
            // Status events are metadata (usage_update, mode change, etc.)
            // and fire frequently mid-stream. Don't surface their text via
            // onMessage - it would flicker over the actual assistant message
            // the user is reading.
            continue;
          }
        }
        flushPendingMessage();
      } catch (error) {
        await Promise.allSettled([
          Promise.resolve().then(() =>
            turn.cancel({ reason: "gnhf-stream-ended" }),
          ),
          turn.result,
        ]);
        if (signal?.aborted || isAbortError(error)) {
          appendDebugLog("acp:turn:aborted", {
            target: redactAcpTargetForLogs(this.target),
            requestId,
            elapsedMs: Date.now() - startedAt,
          });
          throw createAbortError();
        }
        appendDebugLog("acp:turn:stream-error", {
          target: redactAcpTargetForLogs(this.target),
          requestId,
          elapsedMs: Date.now() - startedAt,
          error: serializeAcpErrorForLog(error, this.target),
        });
        throw redactAcpErrorForThrow(error, this.target);
      }

      const result: AcpRuntimeTurnResult = await turn.result;
      appendDebugLog("acp:turn:result", {
        target: redactAcpTargetForLogs(this.target),
        requestId,
        status: result.status,
        stopReason:
          result.status === "completed" || result.status === "cancelled"
            ? result.stopReason
            : undefined,
        errorCode: result.status === "failed" ? result.error.code : undefined,
        retryable:
          result.status === "failed" ? result.error.retryable : undefined,
        elapsedMs: Date.now() - startedAt,
        outputLength: outputBuf.length,
      });

      if (result.status === "cancelled") {
        throw createAbortError();
      }
      if (result.status === "failed") {
        const message = redactRawAcpTargetInString(
          result.error.message || "ACP turn failed",
          this.target,
        );
        if (result.error.retryable === false) {
          throw new PermanentAgentError(
            message,
            result.error.code ?? "ACP_TURN_FAILED",
          );
        }
        throw new Error(message);
      }

      if (lastOutputMessage.length === 0 && outputBuf.length === 0) {
        throw new Error("ACP agent returned no output text");
      }

      // Try the most recent assistant message first - that's where the
      // structured answer is supposed to live. Fall back to extracting a
      // JSON object out of the full output stream if the last message
      // alone doesn't parse (e.g. the agent streamed prose and JSON in
      // one uninterrupted message, so we have to dig the JSON out).
      let parsed = parseAgentJson(lastOutputMessage);
      if (parsed === null && outputBuf !== lastOutputMessage) {
        parsed = parseAgentJson(outputBuf);
      }
      if (parsed === null) {
        const preview = (lastOutputMessage || outputBuf).slice(0, 200);
        throw new Error(
          `Failed to parse ACP agent output as JSON. Last assistant message started with: ${JSON.stringify(preview)}`,
        );
      }

      const output = validateAgentOutput(parsed, this.schema);
      return {
        output,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          tokensAvailable: false,
        },
      };
    } finally {
      logStream?.end();
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.closing;
      return;
    }
    if (this.closed && this.runtime === null && this.handle === null) return;
    this.closing = this.shutdown();
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    if (!this.runtime || !this.handle) return;

    const runtime = this.runtime;
    const handle = this.handle;
    try {
      await runtime.close({ handle, reason: "gnhf-shutdown" });
      this.runtime = null;
      this.handle = null;
      appendDebugLog("acp:close", {
        target: redactAcpTargetForLogs(this.target),
      });
    } catch (error) {
      appendDebugLog("acp:close-error", {
        target: redactAcpTargetForLogs(this.target),
        error: serializeAcpErrorForLog(error, this.target),
      });
      throw new IncompleteAgentShutdownError(
        "Could not prove ACP runtime cleanup completed",
        { cause: redactAcpErrorForThrow(error, this.target) },
      );
    }
  }

  private ensureRuntime(cwd: string): AcpxRuntimeLike {
    if (this.runtime) return this.runtime;
    const runtime = this.runtimeFactory({
      cwd,
      sessionStore: createFileSessionStore({ stateDir: this.sessionStateDir }),
      agentRegistry: createAgentRegistry(
        this.registryOverrides
          ? { overrides: this.registryOverrides }
          : undefined,
      ),
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    this.runtime = runtime;
    appendDebugLog("acp:runtime:created", {
      target: redactAcpTargetForLogs(this.target),
      sessionStateDir: this.sessionStateDir,
      cwd,
    });
    return runtime;
  }
}
