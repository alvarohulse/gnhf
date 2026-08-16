import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { Command, InvalidArgumentError } from "commander";
import {
  AGENT_NAMES,
  isAgentSpec,
  loadConfig,
  redactAgentSpecForLogs,
  type AgentName,
  type AgentSpec,
} from "./core/config.js";
import {
  appendDebugLog,
  initDebugLog,
  serializeError,
} from "./core/debug-log.js";
import {
  ensureCleanWorkingTree,
  createBranch,
  getHeadCommit,
  getCurrentBranch,
  getRepoRootDir,
  createWorktree,
  removeWorktree,
  listWorktreePaths,
  getBranchDiffStats,
  type BranchDiffStats,
} from "./core/git.js";
import {
  type RunInfo,
  type RunRuntimeLimitOverrides,
  type RunSchemaOptions,
  setupRun,
  resumeRun,
  peekRunMetadata,
  getLastIterationNumber,
} from "./core/run.js";
import { readStdinText } from "./core/stdin.js";
import { startSleepPrevention } from "./core/sleep.js";
import {
  getWorktreePreservationReason,
  type WorktreePreservationReason,
} from "./core/worktree-preservation.js";
import { createAgent } from "./core/agents/factory.js";
import { getDefaultTelemetry, initDefaultTelemetry } from "./core/telemetry.js";
import {
  getCommitMessageSchemaFields,
  type CommitMessageConfig,
} from "./core/commit-message.js";
import { Orchestrator } from "./core/orchestrator.js";
import { renderExitSummary } from "./core/exit-summary.js";
import { writeConfiguredWorktreeReceipt } from "./core/worktree-receipt.js";
import { MockOrchestrator } from "./mock-orchestrator.js";
import { Renderer } from "./renderer.js";
import { slugifyPrompt } from "./utils/slugify.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;
const FORCE_EXIT_TIMEOUT_MS = 5_000;
const MAX_METEOR_FREQUENCY = 5;
const GNHF_REEXEC_STDIN_PROMPT = "GNHF_REEXEC_STDIN_PROMPT";
const GNHF_REEXEC_STDIN_PROMPT_FILE = "GNHF_REEXEC_STDIN_PROMPT_FILE";
const GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX = "gnhf-stdin-";
const GNHF_REEXEC_STDIN_PROMPT_FILENAME = "prompt.txt";
const AGENT_NAME_SET = new Set<string>(AGENT_NAMES);
const AGENT_NAME_LIST = `"${AGENT_NAMES.slice(0, -1).join('", "')}", or "${
  AGENT_NAMES[AGENT_NAMES.length - 1]
}"`;
const AGENT_SPEC_LIST = `${AGENT_NAME_LIST}, or "acp:<target-or-command>" (e.g. acp:gemini)`;

class PromptSignalError extends Error {
  constructor(public readonly signal: NodeJS.Signals) {
    super(signal);
  }
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a safe integer");
  }

  return parsed;
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("must be a non-negative finite number");
  }

  return parsed;
}

function parseMeteorFrequency(value: string): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed > MAX_METEOR_FREQUENCY) {
    throw new InvalidArgumentError(
      `must be between 0 and ${MAX_METEOR_FREQUENCY}`,
    );
  }
  return parsed;
}

function parseOnOffBoolean(value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new InvalidArgumentError(
    'must be one of: "on", "off", "true", "false"',
  );
}

function humanizeErrorMessage(message: string): string {
  if (message.includes("not a git repository")) {
    return 'This command must be run inside a Git repository. Change into a repo or run "git init" first.';
  }

  return message;
}

function isAgentName(name: string): name is AgentName {
  return AGENT_NAME_SET.has(name);
}

function getNativeAgentName(spec: AgentSpec): AgentName | undefined {
  return isAgentName(spec) ? spec : undefined;
}

function getTelemetryAgent(spec: AgentSpec): string {
  return redactAgentSpecForLogs(spec);
}

function shouldUseColor(): boolean {
  return (
    process.stdout.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== "dumb"
  );
}

function emptyBranchDiffStats(commitCount: number): BranchDiffStats {
  return {
    commits: commitCount,
    filesChanged: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    filesRenamed: 0,
    binaryFiles: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

function redactDebugArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let i = 0; i < redacted.length; i += 1) {
    const arg = redacted[i];
    if (arg === "--") break;
    if (arg === "--agent") {
      const next = redacted[i + 1];
      if (next !== undefined) {
        redacted[i + 1] = redactAgentSpecForLogs(next);
        i += 1;
      }
      continue;
    }
    if (arg?.startsWith("--agent=")) {
      redacted[i] =
        `--agent=${redactAgentSpecForLogs(arg.slice("--agent=".length))}`;
    }
  }
  return redacted;
}

function buildSchemaOptions(
  stopWhen: string | undefined,
  commitMessage: CommitMessageConfig | undefined,
  runtimeLimits?: RunRuntimeLimitOverrides,
): RunSchemaOptions {
  const commitFields = getCommitMessageSchemaFields(commitMessage);
  return {
    includeStopField: stopWhen !== undefined,
    ...(stopWhen === undefined ? {} : { stopWhen }),
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitFields.length === 0 ? {} : { commitFields }),
    ...(runtimeLimits === undefined ? {} : { runtimeLimits }),
  };
}

function buildResumeSchemaOptions(
  stopWhen: string | undefined,
  commitMessage: CommitMessageConfig | undefined,
  runtimeLimits?: RunRuntimeLimitOverrides,
): RunSchemaOptions {
  const commitFields = getCommitMessageSchemaFields(commitMessage);
  if (stopWhen === "") {
    return {
      includeStopField: false,
      clearStopWhen: true,
      ...(commitMessage === undefined ? {} : { commitMessage }),
      ...(commitFields.length === 0 ? {} : { commitFields }),
      ...(runtimeLimits === undefined ? {} : { runtimeLimits }),
    };
  }
  return buildSchemaOptions(stopWhen, commitMessage, runtimeLimits);
}

function initializeNewBranch(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureCleanWorkingTree(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = createBranchWithSuffix(slugifyPrompt(prompt), cwd);
  const runId = branchName.split("/")[1]!;
  return setupRun(runId, prompt, baseCommit, cwd, schemaOptions);
}

function promptRunId(prompt: string): string {
  return slugifyPrompt(prompt).split("/")[1]!;
}

function resumeCurrentBranchRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo | null {
  const runId = promptRunId(prompt);
  if (!existsSync(join(cwd, ".gnhf", "runs", runId))) {
    return null;
  }
  ensureCleanWorkingTree(cwd);
  return resumeRun(runId, cwd, schemaOptions);
}

function initializeCurrentBranchRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureCleanWorkingTree(cwd);
  const baseCommit = getHeadCommit(cwd);
  const runId = createRunIdWithSuffix(promptRunId(prompt), cwd);
  return setupRun(runId, prompt, baseCommit, cwd, schemaOptions);
}

function branchNameWithSuffix(branchName: string, suffix: number): string {
  return suffix === 0 ? branchName : `${branchName}-${suffix}`;
}

function isCollisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|exists already|would be overwritten/i.test(message);
}

function createBranchWithSuffix(branchName: string, cwd: string): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = branchNameWithSuffix(branchName, suffix);
    try {
      createBranch(candidate, cwd);
      return candidate;
    } catch (error) {
      if (!isCollisionError(error)) throw error;
    }
  }
  throw new Error(`Unable to create a unique branch name for ${branchName}`);
}

function runIdWithSuffix(runId: string, suffix: number): string {
  return suffix === 0 ? runId : `${runId}-${suffix}`;
}

function createRunIdWithSuffix(runId: string, cwd: string): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = runIdWithSuffix(runId, suffix);
    if (!existsSync(join(cwd, ".gnhf", "runs", candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to create a unique run id for ${runId}`);
}

interface WorktreeRunResult {
  runInfo: RunInfo;
  worktreePath: string;
  effectiveCwd: string;
  receiptId?: string;
  receiptRunId?: string;
  resumed: boolean;
}

function setupFailureRecordPath(worktreePath: string, runId: string): string {
  return join(worktreePath, ".gnhf", "setup-failures", `${runId}.json`);
}

function preserveWorktreeAfterSetupFailure(
  worktreePath: string,
  runId: string,
  error: unknown,
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const recordPath = setupFailureRecordPath(worktreePath, runId);
  let recordError: string | null = null;
  try {
    mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      recordPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          worktreePath,
          reason: "setup-failed",
          error: errorMessage,
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (recordFailure) {
    recordError =
      recordFailure instanceof Error
        ? recordFailure.message
        : String(recordFailure);
  }

  appendDebugLog("worktree:preserved", {
    worktreePath,
    reason: "setup-failed",
    error: serializeError(error),
    recordPath,
    recordError,
  });
  console.error(
    `\n  gnhf: worktree preserved at ${worktreePath}` +
      `\n  gnhf: run metadata setup failed: ${errorMessage}` +
      `\n  gnhf: preservation record: ${
        recordError === null ? recordPath : `unavailable (${recordError})`
      }` +
      `\n  gnhf: remove only after review with: git worktree remove "${worktreePath}"\n`,
  );
}

function initializeWorktreeRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
  resumeSchemaOptions: RunSchemaOptions,
): WorktreeRunResult {
  // Intentionally skip ensureCleanWorkingTree() — git worktree add creates
  // an independent working directory from HEAD; uncommitted changes in the
  // main checkout don't carry over, so a dirty tree is harmless here.
  const repoRoot = getRepoRootDir(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = slugifyPrompt(prompt);
  const makeWorktreePath = (runId: string) =>
    join(dirname(repoRoot), `${basename(repoRoot)}-gnhf-worktrees`, runId);
  const runId = branchName.split("/")[1]!;
  const worktreePath = makeWorktreePath(runId);
  const registeredWorktreePaths = listWorktreePaths(repoRoot);

  const resumePreservedWorktree = (
    candidateBranchName: string,
    candidateRunId: string,
    candidateWorktreePath: string,
  ): WorktreeRunResult | null => {
    if (
      !registeredWorktreePaths.has(resolve(candidateWorktreePath)) ||
      !existsSync(join(candidateWorktreePath, ".gnhf", "runs", candidateRunId))
    ) {
      return null;
    }

    const receiptId = writeConfiguredWorktreeReceipt({
      runId: candidateRunId,
      state: "created",
      worktreePath: candidateWorktreePath,
    });
    try {
      let worktreeBranch: string;
      try {
        worktreeBranch = getCurrentBranch(candidateWorktreePath);
      } catch (error) {
        throw new Error(
          `Preserved worktree at ${candidateWorktreePath} is in an unexpected state ` +
            `(${error instanceof Error ? error.message : String(error)}). ` +
            `Fix the worktree manually or remove it with ` +
            `"git worktree remove ${candidateWorktreePath}" before re-running.`,
        );
      }
      if (worktreeBranch !== candidateBranchName) {
        throw new Error(
          `Preserved worktree at ${candidateWorktreePath} is on branch ` +
            `"${worktreeBranch}" rather than "${candidateBranchName}". ` +
            `Restore it to "${candidateBranchName}" with "git -C ${candidateWorktreePath} ` +
            `checkout ${candidateBranchName}", or remove the worktree with ` +
            `"git worktree remove ${candidateWorktreePath}" to start fresh.`,
        );
      }
      const runInfo = resumeRun(
        candidateRunId,
        candidateWorktreePath,
        resumeSchemaOptions,
      );
      rmSync(setupFailureRecordPath(candidateWorktreePath, candidateRunId), {
        force: true,
      });
      return {
        runInfo,
        worktreePath: candidateWorktreePath,
        effectiveCwd: candidateWorktreePath,
        ...(receiptId === undefined ? {} : { receiptId }),
        ...(receiptId === undefined ? {} : { receiptRunId: candidateRunId }),
        resumed: true,
      };
    } catch (error) {
      if (receiptId !== undefined) {
        writeConfiguredWorktreeReceipt({
          runId: candidateRunId,
          receiptId,
          state: "shutdown",
          disposition: "preserved",
          preservationReason: "setup-failed",
          worktreePath: candidateWorktreePath,
        });
      }
      throw error;
    }
  };

  let createdBranchName = branchName;
  let createdRunId = runId;
  let createdWorktreePath = worktreePath;
  let worktreeReceiptId: string | undefined;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidateBranchName = branchNameWithSuffix(branchName, suffix);
    const candidateRunId = candidateBranchName.split("/")[1]!;
    const candidateWorktreePath = makeWorktreePath(candidateRunId);
    const resumed = resumePreservedWorktree(
      candidateBranchName,
      candidateRunId,
      candidateWorktreePath,
    );
    if (resumed) return resumed;
  }
  for (let suffix = 0; suffix < 100; suffix += 1) {
    createdBranchName = branchNameWithSuffix(branchName, suffix);
    createdRunId = createdBranchName.split("/")[1]!;
    createdWorktreePath = makeWorktreePath(createdRunId);
    const resumed = resumePreservedWorktree(
      createdBranchName,
      createdRunId,
      createdWorktreePath,
    );
    if (resumed) return resumed;
    worktreeReceiptId = writeConfiguredWorktreeReceipt({
      runId: createdRunId,
      baseCommit,
      ...(worktreeReceiptId === undefined
        ? {}
        : { receiptId: worktreeReceiptId }),
      state: "pending",
      worktreePath: createdWorktreePath,
    });
    try {
      createWorktree(repoRoot, createdWorktreePath, createdBranchName);
    } catch (error) {
      if (!isCollisionError(error)) {
        if (worktreeReceiptId !== undefined) {
          const worktreeWasCreated = existsSync(createdWorktreePath);
          writeConfiguredWorktreeReceipt({
            runId: createdRunId,
            baseCommit,
            receiptId: worktreeReceiptId,
            state: "shutdown",
            disposition: worktreeWasCreated ? "preserved" : "removed",
            ...(worktreeWasCreated
              ? { preservationReason: "setup-failed" }
              : {}),
            worktreePath: createdWorktreePath,
          });
        }
        throw error;
      }
      if (suffix === 99) {
        if (worktreeReceiptId !== undefined) {
          writeConfiguredWorktreeReceipt({
            runId: createdRunId,
            baseCommit,
            receiptId: worktreeReceiptId,
            state: "shutdown",
            disposition: "removed",
            worktreePath: createdWorktreePath,
          });
        }
        throw new Error(`Unable to create a unique worktree for ${branchName}`);
      }
      continue;
    }
    writeConfiguredWorktreeReceipt({
      runId: createdRunId,
      baseCommit,
      ...(worktreeReceiptId === undefined
        ? {}
        : { receiptId: worktreeReceiptId }),
      state: "created",
      worktreePath: createdWorktreePath,
    });
    break;
  }
  let runInfo: RunInfo;
  try {
    runInfo = setupRun(
      createdRunId,
      prompt,
      baseCommit,
      createdWorktreePath,
      schemaOptions,
    );
  } catch (error) {
    preserveWorktreeAfterSetupFailure(createdWorktreePath, createdRunId, error);
    if (worktreeReceiptId !== undefined) {
      writeConfiguredWorktreeReceipt({
        runId: createdRunId,
        baseCommit,
        receiptId: worktreeReceiptId,
        state: "shutdown",
        disposition: "preserved",
        preservationReason: "setup-failed",
        worktreePath: createdWorktreePath,
      });
    }
    throw error;
  }
  return {
    runInfo,
    worktreePath: createdWorktreePath,
    effectiveCwd: createdWorktreePath,
    ...(worktreeReceiptId === undefined
      ? {}
      : { receiptId: worktreeReceiptId }),
    ...(worktreeReceiptId === undefined ? {} : { receiptRunId: createdRunId }),
    resumed: false,
  };
}

function openPromptTerminal(): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  cleanup: () => void;
} {
  if (process.stdin.isTTY) {
    return {
      input: process.stdin,
      output: process.stderr,
      cleanup: () => {},
    };
  }

  const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  const outputPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
  const inputFd = openSync(inputPath, "r");
  try {
    const outputFd = openSync(outputPath, "w");
    try {
      const input = createReadStream("", { autoClose: true, fd: inputFd });
      const output = createWriteStream("", { autoClose: true, fd: outputFd });
      return {
        input,
        output,
        cleanup: () => {
          input.destroy();
          output.destroy();
        },
      };
    } catch (error) {
      closeSync(outputFd);
      throw error;
    }
  } catch (error) {
    closeSync(inputFd);
    throw error;
  }
}

function ask(
  question: string,
  closeMessage: string,
  unavailableMessage: string,
): Promise<string> {
  let terminal;
  try {
    terminal = openPromptTerminal();
  } catch {
    throw new Error(unavailableMessage);
  }

  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  });
  return new Promise((resolve, reject) => {
    const handleClose = () => {
      terminal.cleanup();
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      reject(new Error(closeMessage));
    };

    const handleSigInt = () => {
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      rl.close();
      terminal.cleanup();
      reject(new PromptSignalError("SIGINT"));
    };

    rl.once("close", handleClose);
    rl.once("SIGINT", handleSigInt);
    rl.question(question, (answer) => {
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      rl.close();
      terminal.cleanup();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function getSignalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function persistStdinPromptForReexec(prompt: string): {
  path: string;
  cleanup: () => void;
} {
  const promptDir = mkdtempSync(
    join(tmpdir(), GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX),
  );
  const promptPath = join(promptDir, GNHF_REEXEC_STDIN_PROMPT_FILENAME);
  writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
  return {
    path: promptPath,
    cleanup: () => {
      rmSync(promptDir, { recursive: true, force: true });
    },
  };
}

function isTrustedReexecPromptPath(promptPath: string): boolean {
  const resolvedPromptPath = resolve(promptPath);
  const promptDir = dirname(resolvedPromptPath);
  return (
    basename(resolvedPromptPath) === GNHF_REEXEC_STDIN_PROMPT_FILENAME &&
    dirname(promptDir) === resolve(tmpdir()) &&
    basename(promptDir).startsWith(GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX)
  );
}

function cleanupTrustedReexecPromptPath(promptPath: string): void {
  if (!isTrustedReexecPromptPath(promptPath)) {
    return;
  }

  const resolvedPromptPath = resolve(promptPath);
  rmSync(resolvedPromptPath, { force: true });
  try {
    rmdirSync(dirname(resolvedPromptPath));
  } catch {
    // Leave the directory in place if anything unexpected remains.
  }
}

function readReexecStdinPrompt(env: NodeJS.ProcessEnv): string | undefined {
  const promptPath = env[GNHF_REEXEC_STDIN_PROMPT_FILE];
  if (promptPath !== undefined) {
    delete env[GNHF_REEXEC_STDIN_PROMPT_FILE];
    try {
      return readFileSync(promptPath, "utf-8");
    } finally {
      cleanupTrustedReexecPromptPath(promptPath);
    }
  }

  const prompt = env[GNHF_REEXEC_STDIN_PROMPT];
  if (prompt !== undefined) {
    delete env[GNHF_REEXEC_STDIN_PROMPT];
    return prompt;
  }

  return undefined;
}

const program = new Command();

program
  .name("gnhf")
  .description("Before I go to bed, I tell my agents: good night, have fun")
  .version(packageVersion)
  .argument("[prompt]", "The objective for the coding agent")
  .option(
    "--agent <agent>",
    `Agent to use (${AGENT_NAMES.join(", ")}, or acp:<target-or-command>)`,
  )
  .option(
    "--max-iterations <n>",
    "Abort after N total iterations; persists for this run",
    parseNonNegativeInteger,
  )
  .option("--clear-max-iterations", "Clear the persisted iteration cap", false)
  .option(
    "--max-tokens <n>",
    "Abort after N total input+output tokens; persists for this run",
    parseNonNegativeInteger,
  )
  .option("--clear-max-tokens", "Clear the persisted token cap", false)
  .option(
    "--max-reported-cost-usd <amount>",
    "Abort after the harness reports this total cost in USD; persists for this run",
    parseNonNegativeNumber,
  )
  .option(
    "--clear-max-reported-cost-usd",
    "Clear the persisted reported-cost cap",
    false,
  )
  .option(
    "--stop-when <condition>",
    'End when the agent reports this condition, after any commit-failure repair; resumes reuse it, pass a new value to overwrite or "" to clear',
  )
  .option(
    "--prevent-sleep <mode>",
    'Prevent system sleep during the run ("on" or "off")',
    parseOnOffBoolean,
  )
  .option(
    "--worktree",
    "Run in a separate git worktree (enables multiple agents on the same repo)",
    false,
  )
  .option(
    "--preserve-worktree",
    "Keep the generated worktree after every exit path (requires --worktree)",
    false,
  )
  .option(
    "--current-branch",
    "Run on the current branch instead of creating a gnhf branch",
    false,
  )
  .option(
    "--push",
    "Push the current branch after each successful iteration",
    false,
  )
  .option(
    "--meteor-frequency <n>",
    "Meteor frequency from 0 to 5 (0 disables, 3 is default)",
    parseMeteorFrequency,
    3,
  )
  .option("--mock", "", false)
  .action(
    async (
      promptArg: string | undefined,
      options: {
        agent?: string;
        maxIterations?: number;
        maxTokens?: number;
        maxReportedCostUsd?: number;
        clearMaxIterations: boolean;
        clearMaxTokens: boolean;
        clearMaxReportedCostUsd: boolean;
        stopWhen?: string;
        preventSleep?: boolean;
        worktree: boolean;
        preserveWorktree: boolean;
        currentBranch: boolean;
        push: boolean;
        meteorFrequency: number;
        mock: boolean;
      },
    ) => {
      if (options.mock) {
        const mock = new MockOrchestrator();
        enterAltScreen();
        const renderer = new Renderer(
          mock as unknown as Orchestrator,
          "let's minimize app startup latency without sacrificing any functionality",
          "codex",
          () => {
            mock.handleInterrupt();
          },
          { meteorFrequency: options.meteorFrequency },
        );
        renderer.start();
        mock.start();
        await renderer.waitUntilExit();
        exitAltScreen();
        return;
      }
      let initialSleepPrevention: Awaited<
        ReturnType<typeof startSleepPrevention>
      > | null = null;
      if (process.env.GNHF_SLEEP_INHIBITED === "1") {
        initialSleepPrevention = await startSleepPrevention(
          process.argv.slice(2),
        );
      }
      let prompt = promptArg;
      let promptFromStdin = false;

      const agentName = options.agent;
      if (agentName !== undefined && !isAgentSpec(agentName)) {
        console.error(
          `Unknown agent: ${options.agent}. Use ${AGENT_SPEC_LIST}.`,
        );
        process.exit(1);
      }

      const loadedConfig = loadConfig(
        agentName
          ? {
              agent: agentName,
            }
          : {},
      );
      const config = {
        ...loadedConfig,
        ...(options.preventSleep === undefined
          ? {}
          : { preventSleep: options.preventSleep }),
      };
      if (!isAgentSpec(config.agent)) {
        console.error(
          `Unknown agent: ${config.agent}. Use ${AGENT_SPEC_LIST}.`,
        );
        process.exit(1);
      }

      initDefaultTelemetry({
        app: "gnhf",
        version: packageVersion,
        platform: process.platform,
        arch: process.arch,
      });
      const telemetry = getDefaultTelemetry();
      const runStartedAt = Date.now();

      if (!prompt && process.env.GNHF_SLEEP_INHIBITED === "1") {
        prompt = readReexecStdinPrompt(process.env);
      }
      if (!prompt && !process.stdin.isTTY) {
        prompt = await readStdinText(process.stdin);
        promptFromStdin = true;
      }

      const sleepPreventionState: {
        cleanup: (() => Promise<void>) | null;
        started: boolean;
      } = {
        cleanup: null,
        started: false,
      };
      const startConfiguredSleepPrevention = async () => {
        if (sleepPreventionState.started || !config.preventSleep) {
          return;
        }
        sleepPreventionState.started = true;

        const persistedPrompt =
          promptFromStdin && prompt !== undefined
            ? persistStdinPromptForReexec(prompt)
            : null;
        let reexeced = false;
        try {
          const sleepPrevention =
            initialSleepPrevention ??
            (await startSleepPrevention(process.argv.slice(2), {
              reexecEnv: persistedPrompt
                ? {
                    [GNHF_REEXEC_STDIN_PROMPT_FILE]: persistedPrompt.path,
                  }
                : undefined,
            }));
          if (sleepPrevention.type === "reexeced") {
            reexeced = true;
            process.exit(sleepPrevention.exitCode);
          }
          if (sleepPrevention.type === "active") {
            sleepPreventionState.cleanup = sleepPrevention.cleanup;
          }
        } finally {
          if (!reexeced) {
            persistedPrompt?.cleanup();
          }
        }
      };

      const cwd = process.cwd();
      let effectiveCwd = cwd;
      let worktreePath: string | null = null;
      let worktreeReceiptId: string | undefined;
      let worktreeReceiptRunId: string | undefined;
      let worktreeReceiptBaseCommit: string | undefined;
      let worktreeReceiptFinalized = false;
      let worktreeCleanup: (() => boolean) | null = null;
      let worktreePreservationReason:
        | WorktreePreservationReason
        | "requested"
        | "resumed"
        | null = null;
      let worktreePreservationNoticeEmitted = false;
      let readPendingWorkspaceRecovery = () => false;
      const publishWorktreeShutdownReceipt = (
        disposition: "preserved" | "removed",
        preservationReason?: string,
      ) => {
        if (
          worktreeReceiptId === undefined ||
          worktreeReceiptRunId === undefined ||
          worktreePath === null ||
          worktreeReceiptFinalized
        ) {
          return;
        }
        writeConfiguredWorktreeReceipt({
          runId: worktreeReceiptRunId,
          ...(worktreeReceiptBaseCommit === undefined
            ? {}
            : { baseCommit: worktreeReceiptBaseCommit }),
          receiptId: worktreeReceiptId,
          state: "shutdown",
          disposition,
          ...(preservationReason === undefined ? {} : { preservationReason }),
          worktreePath,
        });
        worktreeReceiptFinalized = true;
      };
      const preserveWorktree = (
        preservationReason:
          | WorktreePreservationReason
          | "requested"
          | "resumed",
      ) => {
        if (worktreePath === null || worktreePreservationNoticeEmitted) {
          return;
        }
        worktreeCleanup = null;
        worktreePreservationReason = preservationReason;
        publishWorktreeShutdownReceipt("preserved", preservationReason);
        worktreePreservationNoticeEmitted = true;
        appendDebugLog("worktree:preserved", {
          worktreePath,
          reason: preservationReason,
        });
        console.error(
          `\n  gnhf: worktree preserved at ${worktreePath}` +
            `\n  gnhf: merge the branch and remove with: git worktree remove "${worktreePath}"\n`,
        );
      };

      const currentBranch = getCurrentBranch(cwd);
      const onGnhfBranch = currentBranch.startsWith("gnhf/");

      if (options.currentBranch && options.worktree) {
        console.error("Cannot combine --current-branch and --worktree.");
        process.exit(1);
      }
      if (options.preserveWorktree && !options.worktree) {
        console.error("Cannot use --preserve-worktree without --worktree.");
        process.exit(1);
      }

      for (const [value, clear, label] of [
        [options.maxIterations, options.clearMaxIterations, "max iterations"],
        [options.maxTokens, options.clearMaxTokens, "max tokens"],
        [
          options.maxReportedCostUsd,
          options.clearMaxReportedCostUsd,
          "max reported cost",
        ],
      ] as const) {
        if (value !== undefined && clear) {
          console.error(
            `Cannot set and clear ${label} in the same invocation.`,
          );
          process.exit(1);
        }
      }

      const parsedRuntimeLimitOverrides: RunRuntimeLimitOverrides = {
        ...(options.clearMaxIterations
          ? { maxIterations: null }
          : options.maxIterations === undefined
            ? {}
            : { maxIterations: options.maxIterations }),
        ...(options.clearMaxTokens
          ? { maxTokens: null }
          : options.maxTokens === undefined
            ? {}
            : { maxTokens: options.maxTokens }),
        ...(options.clearMaxReportedCostUsd
          ? { maxReportedCostUsd: null }
          : options.maxReportedCostUsd === undefined
            ? {}
            : { maxReportedCostUsd: options.maxReportedCostUsd }),
      };
      const runtimeLimitOverrides =
        Object.keys(parsedRuntimeLimitOverrides).length === 0
          ? undefined
          : parsedRuntimeLimitOverrides;

      const cliStopWhen =
        options.stopWhen === "" ? undefined : options.stopWhen;
      let effectiveStopWhen = cliStopWhen;
      let effectiveCommitMessage = config.commitMessage;
      let schemaOptions = buildSchemaOptions(
        effectiveStopWhen,
        effectiveCommitMessage,
        runtimeLimitOverrides,
      );

      let runInfo: RunInfo;
      let startIteration = 0;

      if (options.worktree) {
        if (!prompt) {
          program.help();
          return;
        }

        if (onGnhfBranch) {
          console.error(
            "Cannot use --worktree from a gnhf branch. Switch to the base branch first.",
          );
          process.exit(1);
        }

        await startConfiguredSleepPrevention();

        const wt = initializeWorktreeRun(
          prompt,
          cwd,
          schemaOptions,
          buildResumeSchemaOptions(
            options.stopWhen,
            effectiveCommitMessage,
            runtimeLimitOverrides,
          ),
        );
        runInfo = wt.runInfo;
        effectiveCwd = wt.effectiveCwd;
        worktreePath = wt.worktreePath;
        worktreeReceiptId = wt.receiptId;
        worktreeReceiptRunId = wt.receiptRunId;
        worktreeReceiptBaseCommit = runInfo.baseCommit;

        if (options.preserveWorktree) {
          worktreePreservationReason = "requested";
        } else if (wt.resumed) {
          worktreePreservationReason = "resumed";
        }

        if (worktreePreservationReason !== null) {
          const exitPreservationReason = worktreePreservationReason;
          process.on("exit", () => {
            preserveWorktree(exitPreservationReason);
          });
        }

        if (wt.resumed) {
          // Preserved worktree is always kept on exit regardless of this
          // invocation's commit count; previous commits are already there.
          effectiveStopWhen = runInfo.stopWhen;
          effectiveCommitMessage = runInfo.commitMessage;
          schemaOptions = buildSchemaOptions(
            effectiveStopWhen,
            effectiveCommitMessage,
            runtimeLimitOverrides,
          );
          startIteration = getLastIterationNumber(runInfo);
          console.error(
            `\n  gnhf: resuming preserved worktree at ${worktreePath}` +
              `\n  gnhf: continuing run ${runInfo.runId} from iteration ${startIteration}\n`,
          );
        } else if (!options.preserveWorktree) {
          worktreeCleanup = () => {
            try {
              removeWorktree(cwd, wt.worktreePath);
            } catch {
              preserveWorktree("uncertain");
              return false;
            }
            worktreeCleanup = null;
            publishWorktreeShutdownReceipt("removed");
            return true;
          };

          // Ensure worktree cleanup runs even if die() or process.exit() is
          // called before reaching the normal cleanup block (e.g. orchestrator
          // crash to .catch to die to process.exit(1)).
          const exitCleanup = worktreeCleanup;
          process.on("exit", () => {
            if (worktreeCleanup !== exitCleanup) {
              return;
            }
            const preservationReason = getWorktreePreservationReason(
              runInfo.baseCommit,
              wt.worktreePath,
              readPendingWorkspaceRecovery(),
            );
            if (preservationReason !== null) {
              preserveWorktree(preservationReason);
              return;
            }
            exitCleanup();
          });
        }
      } else if (options.currentBranch) {
        if (!prompt) {
          program.help();
          return;
        }

        const existing = resumeCurrentBranchRun(
          prompt,
          cwd,
          buildResumeSchemaOptions(
            options.stopWhen,
            effectiveCommitMessage,
            runtimeLimitOverrides,
          ),
        );

        if (existing) {
          runInfo = existing;
          effectiveStopWhen = existing.stopWhen;
          effectiveCommitMessage = existing.commitMessage;
          schemaOptions = buildSchemaOptions(
            effectiveStopWhen,
            effectiveCommitMessage,
            runtimeLimitOverrides,
          );
          startIteration = getLastIterationNumber(existing);
        } else {
          runInfo = initializeCurrentBranchRun(prompt, cwd, schemaOptions);
        }
      } else if (onGnhfBranch) {
        const existingRunId = currentBranch.slice("gnhf/".length);
        const existingMetadata = peekRunMetadata(existingRunId, cwd);
        effectiveCommitMessage = existingMetadata.commitMessage;
        const existingPrompt = readFileSync(
          existingMetadata.promptPath,
          "utf-8",
        );

        if (!prompt || prompt === existingPrompt) {
          const existing = resumeRun(
            existingRunId,
            cwd,
            buildResumeSchemaOptions(
              options.stopWhen,
              existingMetadata.commitMessage,
              runtimeLimitOverrides,
            ),
          );
          const resumeStopWhen = existing.stopWhen;
          const resumeSchemaOptions = buildSchemaOptions(
            resumeStopWhen,
            existing.commitMessage,
            runtimeLimitOverrides,
          );
          prompt = existingPrompt;
          runInfo = existing;
          effectiveStopWhen = resumeStopWhen;
          effectiveCommitMessage = existing.commitMessage;
          schemaOptions = resumeSchemaOptions;
          startIteration = getLastIterationNumber(existing);
        } else {
          const answer = await ask(
            `You are on gnhf branch "${currentBranch}".\n` +
              `  (o) Update prompt and continue current run\n` +
              `  (n) Start a new branch on top of this one\n` +
              `  (q) Quit\n` +
              `Choose [o/n/q]: `,
            "The overwrite prompt closed before a choice was entered. Re-run gnhf from an interactive terminal and choose o, n, or q.",
            "Cannot show the overwrite prompt because stdin is not interactive. Re-run gnhf from an interactive terminal and choose o, n, or q.",
          );

          if (answer === "o") {
            ensureCleanWorkingTree(cwd);
            const existing = resumeRun(
              existingRunId,
              cwd,
              buildResumeSchemaOptions(
                options.stopWhen,
                existingMetadata.commitMessage,
                runtimeLimitOverrides,
              ),
            );
            const resumeStopWhen = existing.stopWhen;
            const resumeSchemaOptions = buildSchemaOptions(
              resumeStopWhen,
              existing.commitMessage,
              runtimeLimitOverrides,
            );
            runInfo = setupRun(
              existingRunId,
              prompt,
              existing.baseCommit,
              cwd,
              resumeSchemaOptions,
            );
            effectiveStopWhen = resumeStopWhen;
            effectiveCommitMessage = existing.commitMessage;
            schemaOptions = resumeSchemaOptions;
            startIteration = getLastIterationNumber(existing);
          } else if (answer === "n") {
            effectiveStopWhen = cliStopWhen;
            effectiveCommitMessage = config.commitMessage;
            schemaOptions = buildSchemaOptions(
              effectiveStopWhen,
              effectiveCommitMessage,
              runtimeLimitOverrides,
            );
            runInfo = initializeNewBranch(prompt, cwd, schemaOptions);
          } else {
            process.exit(0);
          }
        }
      } else {
        if (!prompt) {
          program.help();
          return;
        }

        runInfo = initializeNewBranch(prompt, cwd, schemaOptions);
      }

      await startConfiguredSleepPrevention();

      const runMode: "new" | "resume" | "worktree" | "current-branch" =
        options.worktree
          ? "worktree"
          : options.currentBranch
            ? "current-branch"
            : startIteration > 0
              ? "resume"
              : "new";

      const telemetryAgent = getTelemetryAgent(config.agent);
      telemetry.pageview("/run", {
        agent: telemetryAgent,
        mode: runMode,
      });

      initDebugLog(runInfo.logPath);
      appendDebugLog("run:start", {
        args: redactDebugArgs(process.argv.slice(2)),
        runId: runInfo.runId,
        runDir: runInfo.runDir,
        agent: redactAgentSpecForLogs(config.agent),
        promptLength: prompt.length,
        promptFromStdin,
        startIteration,
        maxIterations: runInfo.runtimeLimits.maxIterations,
        maxTokens: runInfo.runtimeLimits.maxTokens,
        maxReportedCostUsd: runInfo.runtimeLimits.maxReportedCostUsd,
        stopWhen: effectiveStopWhen,
        commitMessage: effectiveCommitMessage,
        preventSleep: config.preventSleep,
        agentArgsOverride: getNativeAgentName(config.agent)
          ? config.agentArgsOverride?.[getNativeAgentName(config.agent)!]
          : undefined,
        worktree: options.worktree,
        worktreePath,
        currentBranch: options.currentBranch,
        push: options.push,
        platform: process.platform,
        nodeVersion: process.version,
        gnhfVersion: packageVersion,
      });

      const nativeAgent = getNativeAgentName(config.agent);
      const agent = createAgent(
        config.agent,
        runInfo,
        nativeAgent ? config.agentPathOverride[nativeAgent] : undefined,
        nativeAgent ? config.agentArgsOverride?.[nativeAgent] : undefined,
        {
          ...buildSchemaOptions(effectiveStopWhen, effectiveCommitMessage),
          acpRegistryOverrides: config.acpRegistryOverrides,
        },
      );
      const orchestrator = new Orchestrator(
        { ...config, commitMessage: effectiveCommitMessage },
        agent,
        runInfo,
        prompt,
        effectiveCwd,
        startIteration,
        {
          maxIterations: runInfo.runtimeLimits.maxIterations,
          maxTokens: runInfo.runtimeLimits.maxTokens,
          ...(runInfo.runtimeLimits.maxReportedCostUsd !== undefined
            ? {
                maxReportedCostUsd: runInfo.runtimeLimits.maxReportedCostUsd,
              }
            : {}),
          stopWhen: effectiveStopWhen,
          ...(options.push ? { push: true } : {}),
          ...(options.worktree ? { preserveWorkspaceOnForceStop: true } : {}),
        },
      );
      readPendingWorkspaceRecovery = () =>
        orchestrator.getState().hasPendingWorkspaceRecovery === true;
      let shutdownSignal: NodeJS.Signals | null = null;
      let forceShutdownRequested = false;

      const requestForceShutdown = (signal: NodeJS.Signals) => {
        if (forceShutdownRequested) return;
        forceShutdownRequested = true;
        shutdownSignal = signal;
        appendDebugLog(`signal:${signal}`);
        renderer.stop();
      };
      const handleSigInt = () => {
        const disposition = orchestrator.handleInterrupt();
        if (disposition === "force-stop") {
          requestForceShutdown("SIGINT");
          return;
        }
        if (disposition === "exit") {
          shutdownSignal = "SIGINT";
          appendDebugLog("signal:SIGINT");
          renderer.stop("interrupted");
          return;
        }
        shutdownSignal = "SIGINT";
        appendDebugLog("signal:SIGINT");
      };
      const handleSigTerm = () => {
        orchestrator.stop();
        requestForceShutdown("SIGTERM");
      };

      enterAltScreen();
      const renderer = new Renderer(
        orchestrator,
        prompt,
        config.agent,
        handleSigInt,
        { meteorFrequency: options.meteorFrequency },
      );
      renderer.start();

      process.on("SIGINT", handleSigInt);
      process.on("SIGTERM", handleSigTerm);

      const orchestratorPromise = orchestrator
        .start()
        .finally(() => {
          // Only aborted runs keep the done screen open. Graceful stops should
          // exit as soon as the current iteration and shutdown cleanup finish,
          // but a real abort still deserves the done screen even if a prior
          // ctrl+c already set the eventual SIGINT exit code.
          const keepTui =
            orchestrator.getState().status === "aborted" && process.stdin.isTTY;
          if (!keepTui) {
            renderer.stop();
          }
        })
        .catch((err) => {
          appendDebugLog("orchestrator:fatal", {
            error: serializeError(err),
          });
          exitAltScreen();
          die(err instanceof Error ? err.message : String(err));
        });

      try {
        const rendererExitReason = await renderer.waitUntilExit();
        if (rendererExitReason === "interrupted" && !shutdownSignal) {
          shutdownSignal = "SIGINT";
          appendDebugLog("signal:SIGINT");
        }
        exitAltScreen();
        const shutdownResult = await Promise.race([
          orchestratorPromise.then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), FORCE_EXIT_TIMEOUT_MS).unref();
          }),
        ]);

        if (shutdownResult === "timeout") {
          appendDebugLog("run:shutdown-timeout", {
            timeoutMs: FORCE_EXIT_TIMEOUT_MS,
          });
          console.error(
            `\n  gnhf: shutdown timed out after ${FORCE_EXIT_TIMEOUT_MS / 1000}s, forcing exit\n`,
          );
          if (worktreePath !== null) {
            preserveWorktree(worktreePreservationReason ?? "uncertain");
          }
          process.exit(getSignalExitCode(shutdownSignal ?? "SIGINT"));
        }
      } finally {
        process.off("SIGINT", handleSigInt);
        process.off("SIGTERM", handleSigTerm);
        await sleepPreventionState.cleanup?.();
      }

      {
        const finalState = orchestrator.getState();
        let finalBranchName = "HEAD";
        try {
          finalBranchName = getCurrentBranch(effectiveCwd);
        } catch (error) {
          appendDebugLog("summary:branch-error", {
            error: serializeError(error),
          });
        }

        let diffStats = emptyBranchDiffStats(finalState.commitCount);
        try {
          diffStats = getBranchDiffStats(runInfo.baseCommit, effectiveCwd);
        } catch (error) {
          appendDebugLog("summary:diff-stats-error", {
            error: serializeError(error),
          });
        }

        const exitSummary = renderExitSummary({
          agentName: redactAgentSpecForLogs(config.agent),
          branchName: finalBranchName,
          elapsedMs: Date.now() - finalState.startTime.getTime(),
          status: finalState.status,
          abortReason: finalState.lastAgentError ?? finalState.lastMessage,
          iterations: finalState.currentIteration,
          successCount: finalState.successCount,
          failCount: finalState.failCount,
          totalInputTokens: finalState.totalInputTokens,
          totalOutputTokens: finalState.totalOutputTokens,
          tokensAvailable: finalState.tokensAvailable,
          tokensEstimated: finalState.tokensEstimated,
          commitCount: finalState.commitCount,
          notesPath: runInfo.notesPath,
          logPath: runInfo.logPath,
          baseRef: runInfo.baseCommit.slice(0, 12) || runInfo.baseCommit,
          diffStats,
          color: shouldUseColor(),
          terminalColumns: process.stdout.columns,
          hasPendingCommitFailure: finalState.hasPendingCommitFailure,
        });

        appendDebugLog("run:complete", {
          signal: shutdownSignal,
          status: finalState.status,
          iterations: finalState.currentIteration,
          successCount: finalState.successCount,
          failCount: finalState.failCount,
          totalInputTokens:
            finalState.tokensAvailable === false
              ? null
              : finalState.totalInputTokens,
          totalOutputTokens:
            finalState.tokensAvailable === false
              ? null
              : finalState.totalOutputTokens,
          tokensAvailable: finalState.tokensAvailable !== false,
          reportedCostUsd: finalState.reportedCostUsd,
          commitCount: finalState.commitCount,
          worktreePath,
        });

        telemetry.track("run", {
          agent: telemetryAgent,
          mode: runMode,
          status: finalState.status,
          signal: shutdownSignal ?? undefined,
          iterations: finalState.currentIteration,
          success_count: finalState.successCount,
          fail_count: finalState.failCount,
          commit_count: finalState.commitCount,
          total_input_tokens:
            finalState.tokensAvailable === false
              ? null
              : finalState.totalInputTokens,
          total_output_tokens:
            finalState.tokensAvailable === false
              ? null
              : finalState.totalOutputTokens,
          tokens_available: finalState.tokensAvailable !== false,
          duration_ms: Date.now() - runStartedAt,
          prevent_sleep: config.preventSleep === true,
          push_each_iteration: options.push === true,
          commit_message_preset: effectiveCommitMessage?.preset ?? "default",
          stop_when_set: effectiveStopWhen !== undefined,
        });
        await telemetry.close(1_000);

        if (finalState.status === "aborted") {
          console.error(`\n  gnhf: Run log: ${runInfo.logPath}\n`);
        }

        if (worktreePath) {
          const preservationReason =
            worktreePreservationReason ??
            getWorktreePreservationReason(
              runInfo.baseCommit,
              worktreePath,
              finalState.hasPendingWorkspaceRecovery === true,
            );
          if (preservationReason !== null) {
            preserveWorktree(preservationReason);
          } else {
            const cleanedUp = worktreeCleanup?.() === true;
            worktreeCleanup = null;
            if (cleanedUp) {
              appendDebugLog("worktree:cleaned-up", {
                worktreePath,
              });
            }
          }
        }

        process.stdout.write(exitSummary);
      }

      if (shutdownSignal) {
        process.exit(getSignalExitCode(shutdownSignal));
      }
    },
  );

function enterAltScreen() {
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");
}

function exitAltScreen() {
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
}

function die(message: string): never {
  console.error(`\n  gnhf: ${humanizeErrorMessage(message)}\n`);
  process.exit(1);
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof PromptSignalError) {
    process.exit(getSignalExitCode(err.signal));
  }
  die(err instanceof Error ? err.message : String(err));
}
