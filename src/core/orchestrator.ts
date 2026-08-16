import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  getTokenUsageTotal,
  hasCompleteTokenUsage,
  IncompleteAgentShutdownError,
  PermanentAgentError,
  type Agent,
  type AgentOutput,
  type TokenUsage,
} from "./agents/types.js";
import { redactAgentSpecForLogs, type Config } from "./config.js";
import type { RunInfo, WorkspaceRecovery } from "./run.js";
import {
  appendNotes,
  clearWorkspaceRecovery,
  readRunUsageState,
  readWorkspaceRecovery,
  toStringArray,
  writeRunUsageState,
  writeWorkspaceRecovery,
} from "./run.js";
import { appendDebugLog, serializeError } from "./debug-log.js";
import {
  CommitFailedError,
  commitAll,
  getBranchCommitCount,
  getCurrentBranch,
  getHeadCommit,
  resetHard,
} from "./git.js";
import {
  getInterruptDisposition,
  getInterruptHint,
  type InterruptDisposition,
  type InterruptHint,
} from "./interrupt-state.js";
import { buildCommitMessage } from "./commit-message.js";
import { buildIterationPrompt } from "../templates/iteration-prompt.js";

export interface IterationRecord {
  number: number;
  success: boolean;
  summary: string;
  keyChanges: string[];
  keyLearnings: string[];
  timestamp: Date;
}

export type { InterruptDisposition, InterruptHint } from "./interrupt-state.js";

export interface OrchestratorState {
  status: "running" | "waiting" | "aborted" | "stopped";
  gracefulStopRequested: boolean;
  interruptHint: InterruptHint;
  currentIteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  reportedCostUsd: number | null;
  tokensAvailable?: boolean;
  // Sticky diagnostic flag for completed iterations that returned estimates.
  tokensEstimated: boolean;
  commitCount: number;
  iterations: IterationRecord[];
  successCount: number;
  failCount: number;
  consecutiveFailures: number;
  consecutiveErrors: number;
  startTime: Date;
  waitingUntil: Date | null;
  lastMessage: string | null;
  lastAgentError?: string | null;
  hasPendingCommitFailure?: boolean;
  hasPendingWorkspaceRecovery?: boolean;
}

export interface OrchestratorEvents {
  state: [OrchestratorState];
  "iteration:start": [number];
  "iteration:end": [IterationRecord];
  abort: [string];
  stopped: [];
}

export interface RunLimits {
  maxIterations?: number;
  maxTokens?: number;
  maxReportedCostUsd?: number;
  stopWhen?: string;
  preserveWorkspaceOnForceStop?: boolean;
}

const STOP_CLOSE_AGENT_GRACE_MS = 250;

type RunIterationResult =
  | {
      type: "completed";
      record: IterationRecord;
      shouldFullyStop: boolean;
      abortReason?: string;
    }
  | { type: "stopped" }
  | { type: "aborted"; reason: string };

type AgentRunOutcome = "aborted" | "completed" | "error" | "stopped";

type AppendAgentRunReceiptParams = {
  iteration: number;
  startedAt: number;
  outcome: AgentRunOutcome;
  success: boolean | null;
  usage: TokenUsage | null;
};

type PersistedTokenLowerBounds = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
};

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private config: Config;
  private agent: Agent;
  private runInfo: RunInfo;
  private cwd: string;
  private prompt: string;
  private limits: RunLimits;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private activeIterationPromise: Promise<RunIterationResult> | null = null;
  private activeAbortController: AbortController | null = null;
  private pendingAbortReason: string | null = null;
  private pendingWorkspaceRecovery: WorkspaceRecovery | null = null;
  private activeWorkspaceRecoveryMarker = false;
  private closePromise: Promise<void> | null = null;
  private activeIterationTokensAvailable: boolean | null = null;
  private activeIterationTokensEstimated = false;
  private hasAuthoritativeTokenReceipt = false;
  private totalTokens = 0;
  private tokensUnavailable = false;
  private reportedCostUnavailable = false;
  private reportedCostLowerBoundUsd: number | null = null;
  private unsafeShutdownDetected = false;
  private loopDone = false;
  private stoppedEventEmitted = false;

  private state: Omit<
    OrchestratorState,
    "interruptHint" | "hasPendingCommitFailure" | "hasPendingWorkspaceRecovery"
  > = {
    status: "running",
    gracefulStopRequested: false,
    currentIteration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reportedCostUsd: null,
    tokensEstimated: false,
    commitCount: 0,
    iterations: [],
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date(),
    waitingUntil: null,
    lastMessage: null,
    lastAgentError: null,
  };

  constructor(
    config: Config,
    agent: Agent,
    runInfo: RunInfo,
    prompt: string,
    cwd: string,
    startIteration = 0,
    limits: RunLimits = {},
  ) {
    super();
    this.config = config;
    this.agent = agent;
    this.runInfo = runInfo;
    this.prompt = prompt;
    this.cwd = cwd;
    this.limits = limits;
    this.state.currentIteration = startIteration;
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
    this.pendingWorkspaceRecovery = readWorkspaceRecovery(this.runInfo);
    const usageState = readRunUsageState(this.runInfo);
    if (usageState !== null) {
      const usageGenerationComplete =
        usageState.phase === "terminal" &&
        usageState.generation === startIteration;
      this.state.totalInputTokens = usageState.totalInputTokens;
      this.state.totalOutputTokens = usageState.totalOutputTokens;
      this.totalTokens = usageState.totalTokens;
      this.reportedCostLowerBoundUsd = usageState.reportedCostUsd;
      this.state.reportedCostUsd =
        usageGenerationComplete && !usageState.reportedCostUnavailable
          ? usageState.reportedCostUsd
          : null;
      this.tokensUnavailable =
        usageState.tokensUnavailable || !usageGenerationComplete;
      this.reportedCostUnavailable =
        usageState.reportedCostUnavailable || !usageGenerationComplete;
      this.state.tokensEstimated = usageState.tokensEstimated;
      this.hasAuthoritativeTokenReceipt =
        usageState.hasAuthoritativeTokenReceipt;
    } else if (startIteration > 0) {
      this.tokensUnavailable = true;
      this.reportedCostUnavailable = true;
    }
  }

  getState(): OrchestratorState {
    return {
      ...this.state,
      tokensEstimated:
        this.state.tokensEstimated || this.activeIterationTokensEstimated,
      tokensAvailable:
        !this.tokensUnavailable &&
        this.activeIterationTokensAvailable !== false,
      interruptHint: getInterruptHint(this.state),
      hasPendingCommitFailure:
        this.pendingWorkspaceRecovery?.kind === "commit-failure",
      hasPendingWorkspaceRecovery:
        this.pendingWorkspaceRecovery !== null ||
        this.activeWorkspaceRecoveryMarker,
    };
  }

  requestGracefulStop(): void {
    if (
      this.stopRequested ||
      this.state.gracefulStopRequested ||
      this.loopDone
    ) {
      return;
    }

    this.state.gracefulStopRequested = true;
    appendDebugLog("orchestrator:graceful-stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      status: this.state.status,
    });
    this.emit("state", this.getState());

    if (this.state.status === "waiting") {
      this.activeAbortController?.abort();
    }
  }

  handleInterrupt(): InterruptDisposition {
    const disposition = getInterruptDisposition(this.state);
    if (disposition === "request-graceful-stop") {
      this.requestGracefulStop();
    } else if (disposition === "force-stop") {
      this.stop();
    }
    return disposition;
  }

  stop(): void {
    this.stopRequested = true;
    appendDebugLog("orchestrator:stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      loopDone: this.loopDone,
    });
    this.activeAbortController?.abort();
    this.state.gracefulStopRequested = false;

    if (this.loopDone) {
      this.emitStopped();
      return;
    }

    if (this.stopPromise) return;

    this.stopPromise = (async () => {
      if (this.activeIterationPromise) {
        const iterationPromise = this.activeIterationPromise.catch(
          () => undefined,
        );
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(settle, STOP_CLOSE_AGENT_GRACE_MS);
          timer.unref?.();
          void iterationPromise.finally(settle);
        });
        await this.closeAgent();
        await iterationPromise;
      } else {
        await this.closeAgent();
      }
      if (
        this.limits.preserveWorkspaceOnForceStop !== true &&
        !this.unsafeShutdownDetected
      ) {
        this.resetWorkspace();
      }
      this.state.status = "stopped";
      this.emit("state", this.getState());
      this.emitStopped();
    })();
  }

  async start(): Promise<void> {
    this.state.startTime = new Date();
    this.state.status = "running";
    if (this.state.currentIteration === 0) {
      this.activeIterationTokensAvailable = false;
    }
    // Preserve a pre-start graceful-stop request. ctrl+c can land after the
    // renderer starts listening but before the orchestrator loop begins.
    this.emit("state", this.getState());

    appendDebugLog("orchestrator:start", {
      agent: redactAgentSpecForLogs(this.agent.name),
      runId: this.runInfo.runId,
      startIteration: this.state.currentIteration,
      maxIterations: this.limits.maxIterations,
      maxTokens: this.limits.maxTokens,
      maxReportedCostUsd: this.limits.maxReportedCostUsd,
      maxConsecutiveFailures: this.config.maxConsecutiveFailures,
      baseCommit: this.runInfo.baseCommit,
      initialCommitCount: this.state.commitCount,
    });

    try {
      while (!this.stopRequested) {
        const preIterationAbortReason = this.getPreIterationAbortReason();
        if (preIterationAbortReason) {
          this.abort(preIterationAbortReason);
          break;
        }
        if (this.stopForGracefulShutdown()) {
          break;
        }

        this.state.currentIteration++;
        this.state.status = "running";
        this.activeIterationTokensAvailable = false;
        this.activeIterationTokensEstimated = false;
        this.emit("iteration:start", this.state.currentIteration);
        this.emit("state", this.getState());

        const baseIterationPrompt = buildIterationPrompt({
          n: this.state.currentIteration,
          runId: this.runInfo.runId,
          prompt: this.prompt,
          stopWhen: this.limits.stopWhen,
          commitMessage: this.config.commitMessage,
        });
        const iterationPrompt = this.pendingWorkspaceRecovery
          ? this.buildWorkspaceRecoveryPrompt(
              baseIterationPrompt,
              this.pendingWorkspaceRecovery,
            )
          : baseIterationPrompt;

        appendDebugLog("iteration:start", {
          iteration: this.state.currentIteration,
          promptLength: iterationPrompt.length,
          consecutiveFailures: this.state.consecutiveFailures,
          totalInputTokens: this.tokensUnavailable
            ? null
            : this.state.totalInputTokens,
          totalOutputTokens: this.tokensUnavailable
            ? null
            : this.state.totalOutputTokens,
          tokensAvailable: !this.tokensUnavailable,
          reportedCostUsd: this.state.reportedCostUsd,
          git: this.snapshotGitState(),
        });

        const iterationStartedAt = Date.now();
        this.activeIterationPromise = this.runIteration(iterationPrompt);
        const result = await this.activeIterationPromise;
        this.activeIterationPromise = null;
        const iterationElapsedMs = Date.now() - iterationStartedAt;

        if (result.type === "stopped") {
          appendDebugLog("iteration:stopped", {
            iteration: this.state.currentIteration,
            elapsedMs: iterationElapsedMs,
          });
          break;
        }
        if (result.type === "aborted") {
          appendDebugLog("iteration:aborted", {
            iteration: this.state.currentIteration,
            elapsedMs: iterationElapsedMs,
            reason: result.reason,
          });
          this.abort(result.reason);
          break;
        }

        const { record } = result;
        this.state.iterations.push(record);
        this.emit("iteration:end", record);
        this.emit("state", this.getState());

        appendDebugLog("iteration:end", {
          iteration: record.number,
          elapsedMs: iterationElapsedMs,
          success: record.success,
          summary: record.summary,
          keyChanges: record.keyChanges.length,
          keyLearnings: record.keyLearnings.length,
          consecutiveFailures: this.state.consecutiveFailures,
          totalInputTokens: this.tokensUnavailable
            ? null
            : this.state.totalInputTokens,
          totalOutputTokens: this.tokensUnavailable
            ? null
            : this.state.totalOutputTokens,
          tokensAvailable: !this.tokensUnavailable,
          tokensEstimated: this.state.tokensEstimated,
          commitCount: this.state.commitCount,
        });

        if (result.abortReason) {
          this.abort(result.abortReason);
          break;
        }

        if (this.stopForGracefulShutdown()) {
          break;
        }

        if (this.limits.stopWhen !== undefined && result.shouldFullyStop) {
          this.abort("stop condition met");
          break;
        }

        const postIterationAbortReason = this.getPostIterationAbortReason();
        if (postIterationAbortReason) {
          this.abort(postIterationAbortReason);
          break;
        }

        if (
          this.state.consecutiveFailures >= this.config.maxConsecutiveFailures
        ) {
          this.abort(
            `${this.config.maxConsecutiveFailures} consecutive failures`,
          );
          break;
        }

        if (this.state.consecutiveErrors > 0 && !this.stopRequested) {
          const backoffMs =
            60_000 * Math.pow(2, this.state.consecutiveErrors - 1);
          this.state.status = "waiting";
          this.state.waitingUntil = new Date(Date.now() + backoffMs);
          this.emit("state", this.getState());

          appendDebugLog("backoff:start", {
            iteration: this.state.currentIteration,
            consecutiveErrors: this.state.consecutiveErrors,
            backoffMs,
          });

          await this.interruptibleSleep(backoffMs);

          appendDebugLog("backoff:end", {
            iteration: this.state.currentIteration,
            stopRequested: this.stopRequested,
          });

          this.state.waitingUntil = null;
          if (!this.stopRequested) {
            if (this.stopForGracefulShutdown()) {
              break;
            }
            this.state.status = "running";
            this.emit("state", this.getState());
          }
        }
      }
    } catch (err) {
      appendDebugLog("orchestrator:loop-error", {
        iteration: this.state.currentIteration,
        error: serializeError(err),
      });
      throw err;
    } finally {
      this.activeIterationPromise = null;
      if (this.stopPromise) {
        await this.stopPromise;
      } else {
        await this.closeAgent();
      }
      this.loopDone = true;
      if (this.didStopWithoutForce()) {
        this.emitStopped();
      }
      appendDebugLog("orchestrator:end", {
        status: this.state.status,
        iterations: this.state.currentIteration,
        successCount: this.state.successCount,
        failCount: this.state.failCount,
        totalInputTokens: this.tokensUnavailable
          ? null
          : this.state.totalInputTokens,
        totalOutputTokens: this.tokensUnavailable
          ? null
          : this.state.totalOutputTokens,
        tokensAvailable: !this.tokensUnavailable,
        reportedCostUsd: this.state.reportedCostUsd,
        reportedCostAvailable:
          !this.reportedCostUnavailable && this.state.reportedCostUsd !== null,
        commitCount: this.state.commitCount,
      });
    }
  }

  private async runIteration(prompt: string): Promise<RunIterationResult> {
    const baseInputTokens = this.state.totalInputTokens;
    const baseOutputTokens = this.state.totalOutputTokens;
    const baseTotalTokens = this.totalTokens;
    const baseReportedCostUsd = this.state.reportedCostUsd;
    const baseReportedCostLowerBoundUsd = this.reportedCostLowerBoundUsd;
    let inputTokenLowerBound = baseInputTokens;
    let outputTokenLowerBound = baseOutputTokens;
    let totalTokenLowerBound = baseTotalTokens;
    let agentRunReceiptWritten = false;
    let pendingAbortUsage: TokenUsage | null = null;
    let pendingAbortLimit: "tokens" | "reported-cost" | null = null;

    if (
      this.limits.preserveWorkspaceOnForceStop === true &&
      this.pendingWorkspaceRecovery === null
    ) {
      writeWorkspaceRecovery(this.runInfo, {
        kind: "interrupted",
        detail:
          "The previous invocation stopped before the active iteration completed.",
      });
      this.activeWorkspaceRecoveryMarker = true;
    }

    this.activeAbortController = new AbortController();
    this.pendingAbortReason = null;

    const onUsage = (usage: TokenUsage) => {
      const tokensAvailable = hasCompleteTokenUsage(usage);
      const tokensAuthoritative = tokensAvailable && usage.estimated !== true;
      this.activeIterationTokensAvailable = tokensAvailable;
      if (tokensAuthoritative) {
        updateTokenLowerBounds(usage);
        this.hasAuthoritativeTokenReceipt = true;
        applyTokenLowerBounds(this);
      } else if (tokensAvailable) {
        this.state.totalInputTokens = baseInputTokens + usage.inputTokens;
        this.state.totalOutputTokens = baseOutputTokens + usage.outputTokens;
        this.totalTokens = baseTotalTokens + getTokenUsageTotal(usage);
      } else {
        this.state.totalInputTokens = inputTokenLowerBound;
        this.state.totalOutputTokens = outputTokenLowerBound;
        this.totalTokens = totalTokenLowerBound;
      }
      if (usage.reportedCostUsd !== undefined) {
        this.reportedCostLowerBoundUsd = Math.max(
          this.reportedCostLowerBoundUsd ?? 0,
          (baseReportedCostLowerBoundUsd ?? 0) + usage.reportedCostUsd,
        );
        this.state.reportedCostUsd = !this.reportedCostUnavailable
          ? this.reportedCostLowerBoundUsd
          : null;
      } else {
        this.state.reportedCostUsd = baseReportedCostUsd;
      }
      this.activeIterationTokensEstimated = usage.estimated === true;
      this.writeUsageState(this.state.currentIteration, "in-progress", {
        totalInputTokens: inputTokenLowerBound,
        totalOutputTokens: outputTokenLowerBound,
        totalTokens: totalTokenLowerBound,
      });
      this.emit("state", this.getState());

      const tokenAbortReason = tokensAuthoritative
        ? this.getTokenAbortReason(true)
        : null;
      const reportedCostAbortReason = this.getReportedCostAbortReason();
      const reason = tokenAbortReason ?? reportedCostAbortReason;
      if (this.pendingAbortReason !== null) {
        if (isAuthoritativeAbortUsage(usage)) {
          pendingAbortUsage = { ...usage };
        }
      } else if (reason !== null) {
        this.pendingAbortReason = reason;
        pendingAbortLimit =
          tokenAbortReason !== null ? "tokens" : "reported-cost";
        pendingAbortUsage = { ...usage };
        if (
          this.activeAbortController &&
          !this.activeAbortController.signal.aborted
        ) {
          this.activeAbortController.abort();
        }
      }
    };

    const onMessage = (text: string) => {
      this.state.lastMessage = text;
      this.emit("state", this.getState());
    };

    const logPath = join(
      this.runInfo.runDir,
      `iteration-${this.state.currentIteration}.jsonl`,
    );

    const agentStartedAt = Date.now();
    this.writeUsageState(this.state.currentIteration, "in-progress");
    appendDebugLog("agent:run:start", {
      iteration: this.state.currentIteration,
      agent: redactAgentSpecForLogs(this.agent.name),
      logPath,
    });

    try {
      const result = await this.agent.run(prompt, this.cwd, {
        onUsage,
        onMessage,
        signal: this.activeAbortController.signal,
        logPath,
      });

      if (this.pendingAbortReason !== null && pendingAbortUsage !== null) {
        const abortUsage = isAuthoritativeAbortUsage(result.usage)
          ? result.usage
          : pendingAbortUsage;
        return await settleRuntimeLimitAbort(this, abortUsage);
      }

      if (this.stopRequested) {
        restoreLiveUsage(this);
        this.reportedCostUnavailable = true;
        this.state.reportedCostUsd = null;
        this.appendAgentRunReceipt({
          iteration: this.state.currentIteration,
          startedAt: agentStartedAt,
          outcome: "stopped",
          success: null,
          usage: null,
        });
        agentRunReceiptWritten = true;
        return { type: "stopped" };
      }

      applyTerminalUsage(this, result.usage);

      this.appendAgentRunReceipt({
        iteration: this.state.currentIteration,
        startedAt: agentStartedAt,
        outcome: "completed",
        success: result.output.success,
        usage: result.usage,
      });
      agentRunReceiptWritten = true;

      const shouldFullyStop = result.output.should_fully_stop === true;

      if (result.output.success) {
        const record = this.recordSuccess(result.output);
        return {
          type: "completed",
          record,
          shouldFullyStop: record.success ? shouldFullyStop : false,
        };
      }
      return {
        type: "completed",
        record: this.recordFailure(
          `[FAIL] ${result.output.summary}`,
          result.output.summary,
          toStringArray(result.output.key_learnings),
          "reported",
        ),
        shouldFullyStop,
      };
    } catch (err) {
      const elapsedMs = Date.now() - agentStartedAt;
      if (err instanceof IncompleteAgentShutdownError) {
        this.preserveWorkspaceAfterUnsafeShutdown(err);
        if (!agentRunReceiptWritten) {
          restoreLiveUsage(this);
          this.reportedCostUnavailable = true;
          this.state.reportedCostUsd = null;
          this.appendAgentRunReceipt({
            iteration: this.state.currentIteration,
            startedAt: agentStartedAt,
            outcome: "aborted",
            success: null,
            usage: null,
          });
          agentRunReceiptWritten = true;
        }
        appendDebugLog("agent:run:error", {
          iteration: this.state.currentIteration,
          elapsedMs,
          error: serializeError(err),
        });
        return { type: "aborted", reason: err.message };
      }
      if (this.pendingAbortReason !== null && pendingAbortUsage !== null) {
        return await settleRuntimeLimitAbort(this, pendingAbortUsage);
      }
      if (!agentRunReceiptWritten) {
        restoreLiveUsage(this);
        this.reportedCostUnavailable = true;
        this.state.reportedCostUsd = null;
        const outcome: AgentRunOutcome =
          this.pendingAbortReason !== null || err instanceof PermanentAgentError
            ? "aborted"
            : this.stopRequested
              ? "stopped"
              : "error";
        this.appendAgentRunReceipt({
          iteration: this.state.currentIteration,
          startedAt: agentStartedAt,
          outcome,
          success: null,
          usage: null,
        });
      }

      if (this.stopRequested) {
        appendDebugLog("agent:run:stopped", {
          iteration: this.state.currentIteration,
          elapsedMs,
        });
        return { type: "stopped" };
      }

      // This is where diagnostics most often matter — particularly for
      // `TypeError: fetch failed`, where the surface message is useless
      // without the undici cause chain. Always serialize the full error
      // before we collapse it to a string for the notes file.
      appendDebugLog("agent:run:error", {
        iteration: this.state.currentIteration,
        elapsedMs,
        error: serializeError(err),
      });

      if (err instanceof PermanentAgentError) {
        if (this.pendingWorkspaceRecovery === null) {
          this.resetWorkspace();
        }
        this.state.lastAgentError = err.detail;
        return { type: "aborted", reason: err.message };
      }

      const summary = err instanceof Error ? err.message : String(err);
      return {
        type: "completed",
        record: this.recordFailure(`[ERROR] ${summary}`, summary, [], "error"),
        shouldFullyStop: false,
      };
    } finally {
      this.activeAbortController = null;
      this.activeIterationTokensAvailable = null;
      this.activeIterationTokensEstimated = false;
      this.pendingAbortReason = null;
    }

    function restoreLiveUsage(orchestrator: Orchestrator): void {
      applyTokenLowerBounds(orchestrator);
      orchestrator.state.reportedCostUsd = baseReportedCostUsd;
      orchestrator.activeIterationTokensAvailable = false;
      orchestrator.activeIterationTokensEstimated = false;
    }

    function applyTerminalUsage(
      orchestrator: Orchestrator,
      usage: TokenUsage,
    ): void {
      orchestrator.activeIterationTokensAvailable =
        hasCompleteTokenUsage(usage);
      orchestrator.activeIterationTokensEstimated = false;
      if (hasCompleteTokenUsage(usage)) {
        updateTokenLowerBounds(usage);
        orchestrator.hasAuthoritativeTokenReceipt ||= usage.estimated !== true;
        applyTokenLowerBounds(orchestrator);
      } else {
        applyTokenLowerBounds(orchestrator);
      }
      if (usage.estimated === true) {
        orchestrator.state.tokensEstimated = true;
      }
      if (usage.reportedCostUsd === undefined) {
        orchestrator.reportedCostUnavailable = true;
        orchestrator.state.reportedCostUsd = null;
      } else {
        orchestrator.reportedCostLowerBoundUsd = Math.max(
          orchestrator.reportedCostLowerBoundUsd ?? 0,
          (baseReportedCostLowerBoundUsd ?? 0) + usage.reportedCostUsd,
        );
        orchestrator.state.reportedCostUsd =
          !orchestrator.reportedCostUnavailable
            ? orchestrator.reportedCostLowerBoundUsd
            : null;
      }
    }

    function updateTokenLowerBounds(usage: TokenUsage): void {
      inputTokenLowerBound = Math.max(
        inputTokenLowerBound,
        baseInputTokens + usage.inputTokens,
      );
      outputTokenLowerBound = Math.max(
        outputTokenLowerBound,
        baseOutputTokens + usage.outputTokens,
      );
      totalTokenLowerBound = Math.max(
        totalTokenLowerBound,
        baseTotalTokens + getTokenUsageTotal(usage),
      );
    }

    function applyTokenLowerBounds(orchestrator: Orchestrator): void {
      orchestrator.state.totalInputTokens = inputTokenLowerBound;
      orchestrator.state.totalOutputTokens = outputTokenLowerBound;
      orchestrator.totalTokens = totalTokenLowerBound;
    }

    function isAuthoritativeAbortUsage(usage: TokenUsage): boolean {
      if (pendingAbortLimit === "tokens") {
        return hasCompleteTokenUsage(usage) && usage.estimated !== true;
      }
      if (pendingAbortLimit === "reported-cost") {
        return (
          usage.reportedCostUsd !== undefined &&
          Number.isFinite(usage.reportedCostUsd) &&
          usage.reportedCostUsd >= 0
        );
      }
      return false;
    }

    async function settleRuntimeLimitAbort(
      orchestrator: Orchestrator,
      usage: TokenUsage,
    ): Promise<RunIterationResult> {
      const reason = orchestrator.pendingAbortReason;
      if (reason === null) {
        throw new Error("Runtime limit abort reason is missing");
      }
      applyTerminalUsage(orchestrator, usage);
      orchestrator.appendAgentRunReceipt({
        iteration: orchestrator.state.currentIteration,
        startedAt: agentStartedAt,
        outcome: "aborted",
        success: null,
        usage,
      });
      agentRunReceiptWritten = true;
      appendDebugLog("agent:run:aborted", {
        iteration: orchestrator.state.currentIteration,
        elapsedMs: Date.now() - agentStartedAt,
        reason,
      });
      try {
        await orchestrator.closeAgent();
      } catch (error) {
        if (error instanceof IncompleteAgentShutdownError) {
          return { type: "aborted", reason: error.message };
        }
        throw error;
      }
      if (orchestrator.pendingWorkspaceRecovery === null) {
        orchestrator.resetWorkspace();
      }
      return { type: "aborted", reason };
    }
  }

  private appendAgentRunReceipt({
    iteration,
    startedAt,
    outcome,
    success,
    usage,
  }: AppendAgentRunReceiptParams): void {
    const tokensAvailable = usage !== null && hasCompleteTokenUsage(usage);
    if (!tokensAvailable) {
      this.tokensUnavailable = true;
    }
    this.writeUsageState(iteration, "terminal");
    appendDebugLog("agent:run:end", {
      iteration,
      elapsedMs: Date.now() - startedAt,
      outcome,
      success,
      inputTokens: tokensAvailable ? usage.inputTokens : null,
      outputTokens: tokensAvailable ? usage.outputTokens : null,
      cacheReadTokens: tokensAvailable ? usage.cacheReadTokens : null,
      cacheCreationTokens: tokensAvailable ? usage.cacheCreationTokens : null,
      reportedCostUsd: usage?.reportedCostUsd ?? null,
      reportedCostAvailable: usage?.reportedCostUsd !== undefined,
      tokensAvailable,
      estimated: usage?.estimated ?? false,
    });
  }

  private writeUsageState(
    generation: number,
    phase: "in-progress" | "terminal",
    tokenLowerBounds?: PersistedTokenLowerBounds,
  ): void {
    const persistedTokens =
      tokenLowerBounds === undefined
        ? {
            totalInputTokens: this.state.totalInputTokens,
            totalOutputTokens: this.state.totalOutputTokens,
            totalTokens: this.totalTokens,
          }
        : tokenLowerBounds;
    writeRunUsageState(this.runInfo, {
      generation,
      phase,
      totalInputTokens: persistedTokens.totalInputTokens,
      totalOutputTokens: persistedTokens.totalOutputTokens,
      totalTokens: persistedTokens.totalTokens,
      reportedCostUsd: this.reportedCostLowerBoundUsd,
      tokensUnavailable: this.tokensUnavailable,
      reportedCostUnavailable: this.reportedCostUnavailable,
      tokensEstimated: this.state.tokensEstimated,
      hasAuthoritativeTokenReceipt: this.hasAuthoritativeTokenReceipt,
    });
  }

  private recordSuccess(output: AgentOutput): IterationRecord {
    const keyChanges = toStringArray(output.key_changes_made);
    const keyLearnings = toStringArray(output.key_learnings);
    try {
      commitAll(
        buildCommitMessage(this.config.commitMessage, output, {
          iteration: this.state.currentIteration,
        }),
        this.cwd,
      );
    } catch (error) {
      if (error instanceof CommitFailedError) {
        return this.recordCommitFailure(error);
      }
      throw error;
    }

    this.clearWorkspaceRecovery();
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      output.summary,
      keyChanges,
      keyLearnings,
    );
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
    this.state.successCount++;
    this.state.consecutiveFailures = 0;
    this.state.consecutiveErrors = 0;
    this.state.lastAgentError = null;
    return {
      number: this.state.currentIteration,
      success: true,
      summary: output.summary,
      keyChanges,
      keyLearnings,
      timestamp: new Date(),
    };
  }

  private buildWorkspaceRecoveryPrompt(
    basePrompt: string,
    recovery: WorkspaceRecovery,
  ): string {
    if (recovery.kind === "interrupted") {
      return `${basePrompt}

## Interrupted Workspace Recovery

The previous invocation stopped while an iteration was active, so the workspace may contain incomplete changes.
Do not start unrelated work.
Inspect and finish or repair the existing changes, validate them, then report success.`;
    }

    return `${basePrompt}

## Previous Commit Failure

The previous iteration made workspace changes, but gnhf could not commit them because git commit failed.
Do not start unrelated work.
Inspect and fix the existing uncommitted changes so the commit can pass, then report success.

Git commit output:

\`\`\`
${recovery.detail}
\`\`\``;
  }

  private recordCommitFailure(error: CommitFailedError): IterationRecord {
    this.pendingWorkspaceRecovery = {
      kind: "commit-failure",
      detail: error.detail,
    };
    this.activeWorkspaceRecoveryMarker = false;
    writeWorkspaceRecovery(this.runInfo, this.pendingWorkspaceRecovery);
    const summary = "git commit failed; asking agent to repair the workspace";
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      `[ERROR] ${summary}`,
      [],
      [error.detail],
    );
    this.state.failCount++;
    this.state.consecutiveFailures++;
    this.state.consecutiveErrors = 0;
    this.state.lastAgentError = error.detail;
    return {
      number: this.state.currentIteration,
      success: false,
      summary,
      keyChanges: [],
      keyLearnings: [error.detail],
      timestamp: new Date(),
    };
  }

  private recordFailure(
    notesSummary: string,
    recordSummary: string,
    learnings: string[],
    kind: "reported" | "error",
  ): IterationRecord {
    const hadPendingWorkspaceRecovery = this.pendingWorkspaceRecovery !== null;
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      notesSummary,
      [],
      toStringArray(learnings),
    );
    if (!hadPendingWorkspaceRecovery) {
      this.resetWorkspace();
    }
    this.state.failCount++;
    this.state.consecutiveFailures++;
    // Only hard errors (agent threw) escalate the backoff streak. Explicit
    // agent-reported failures indicate the loop is healthy - the agent tried
    // and concluded it couldn't succeed - so we move straight to the next
    // iteration.
    if (kind === "error") {
      this.state.consecutiveErrors++;
      this.state.lastAgentError = recordSummary;
    } else {
      this.state.consecutiveErrors = 0;
      this.state.lastAgentError = null;
    }
    return {
      number: this.state.currentIteration,
      success: false,
      summary: recordSummary,
      keyChanges: [],
      keyLearnings: toStringArray(learnings),
      timestamp: new Date(),
    };
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.activeAbortController = new AbortController();
      const timer = setTimeout(() => {
        this.activeAbortController = null;
        resolve();
      }, ms);

      this.activeAbortController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        this.activeAbortController = null;
        resolve();
      });
    });
  }

  private clearWorkspaceRecovery(): void {
    clearWorkspaceRecovery(this.runInfo);
    this.pendingWorkspaceRecovery = null;
    this.activeWorkspaceRecoveryMarker = false;
  }

  private resetWorkspace(): void {
    resetHard(this.cwd);
    this.clearWorkspaceRecovery();
  }

  private getPreIterationAbortReason(): string | null {
    if (
      this.limits.maxIterations !== undefined &&
      this.state.currentIteration >= this.limits.maxIterations
    ) {
      return `max iterations reached (${this.limits.maxIterations})`;
    }

    return this.getTokenAbortReason() ?? this.getReportedCostAbortReason();
  }

  private getPostIterationAbortReason(): string | null {
    if (
      this.limits.maxIterations !== undefined &&
      this.state.currentIteration >= this.limits.maxIterations
    ) {
      return `max iterations reached (${this.limits.maxIterations})`;
    }

    return this.getTokenAbortReason() ?? this.getReportedCostAbortReason();
  }

  private getTokenAbortReason(
    hasAuthoritativeReceipt = this.hasAuthoritativeTokenReceipt,
  ): string | null {
    if (
      this.limits.maxTokens === undefined ||
      this.state.tokensEstimated ||
      !hasAuthoritativeReceipt
    ) {
      return null;
    }

    if (this.totalTokens < this.limits.maxTokens) return null;

    return `max tokens reached (${this.totalTokens}/${this.limits.maxTokens})`;
  }

  private getReportedCostAbortReason(): string | null {
    const reportedCostUsd = this.reportedCostUnavailable
      ? this.reportedCostLowerBoundUsd
      : this.state.reportedCostUsd;
    if (
      this.limits.maxReportedCostUsd === undefined ||
      reportedCostUsd === null ||
      reportedCostUsd < this.limits.maxReportedCostUsd
    ) {
      return null;
    }

    return `max reported cost reached ($${reportedCostUsd.toFixed(2)}/$${this.limits.maxReportedCostUsd.toFixed(2)})`;
  }

  private finishGracefulStop(): void {
    this.state.status = "stopped";
    this.state.gracefulStopRequested = false;
    this.state.waitingUntil = null;
    appendDebugLog("orchestrator:graceful-stop-complete", {
      iteration: this.state.currentIteration,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    this.emit("state", this.getState());
  }

  private stopForGracefulShutdown(): boolean {
    if (!this.state.gracefulStopRequested) {
      return false;
    }
    this.finishGracefulStop();
    return true;
  }

  private didStopWithoutForce(): boolean {
    return this.stopPromise === null && this.state.status === "stopped";
  }

  private abort(reason: string): void {
    this.state.status = "aborted";
    this.state.gracefulStopRequested = false;
    this.state.lastMessage = reason;
    this.state.waitingUntil = null;
    appendDebugLog("orchestrator:abort", {
      reason,
      iteration: this.state.currentIteration,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    this.emit("abort", reason);
    this.emit("state", this.getState());
  }

  private async closeAgent(): Promise<void> {
    if (this.closePromise === null) {
      this.closePromise = (async () => {
        try {
          await this.agent.close?.();
        } catch (err) {
          appendDebugLog("agent:close:error", {
            error: serializeError(err),
          });
          if (err instanceof IncompleteAgentShutdownError) {
            this.preserveWorkspaceAfterUnsafeShutdown(err);
            throw err;
          }
        }
      })();
    }
    await this.closePromise;
  }

  private preserveWorkspaceAfterUnsafeShutdown(
    error: IncompleteAgentShutdownError,
  ): void {
    this.unsafeShutdownDetected = true;
    if (this.pendingWorkspaceRecovery === null) {
      this.pendingWorkspaceRecovery = {
        kind: "interrupted",
        detail: error.message,
      };
      writeWorkspaceRecovery(this.runInfo, this.pendingWorkspaceRecovery);
    }
    this.activeWorkspaceRecoveryMarker = false;
    this.state.lastAgentError = error.message;
  }

  private emitStopped(): void {
    if (this.stoppedEventEmitted) {
      return;
    }
    this.stoppedEventEmitted = true;
    this.emit("stopped");
  }

  private snapshotGitState(): Record<string, unknown> {
    // Cheap diagnostic snapshot — catches "previous iteration's reset
    // didn't land" and "we're on the wrong branch" bugs that otherwise
    // look identical to real agent failures.
    try {
      return {
        head: getHeadCommit(this.cwd),
        branch: getCurrentBranch(this.cwd),
        commitCount: this.state.commitCount,
      };
    } catch (err) {
      return {
        error: serializeError(err),
      };
    }
  }
}
