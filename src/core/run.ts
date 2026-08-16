import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildAgentOutputSchema,
  type AgentOutputCommitField,
} from "./agents/types.js";
import {
  CONVENTIONAL_COMMIT_MESSAGE,
  getCommitMessageSchemaFields,
  type CommitMessageConfig,
} from "./commit-message.js";
import { findLegacyRunBaseCommit, getHeadCommit } from "./git.js";

export interface RunInfo {
  runId: string;
  runDir: string;
  promptPath: string;
  notesPath: string;
  schemaPath: string;
  logPath: string;
  baseCommit: string;
  baseCommitPath: string;
  stopWhenPath: string;
  stopWhen: string | undefined;
  commitMessagePath: string;
  commitMessage: CommitMessageConfig | undefined;
  runtimeLimitsPath: string;
  runtimeLimits: RunRuntimeLimits;
}

export interface RunMetadata {
  runId: string;
  runDir: string;
  promptPath: string;
  schemaPath: string;
  commitMessagePath: string;
  commitMessage: CommitMessageConfig | undefined;
}

export interface RunRuntimeLimits {
  maxIterations?: number;
  maxTokens?: number;
  maxReportedCostUsd?: number;
}

export type RunRuntimeLimitOverrides = {
  [Key in keyof RunRuntimeLimits]?: RunRuntimeLimits[Key] | null;
};

export type WorkspaceRecovery = {
  kind: "commit-failure" | "interrupted";
  detail: string;
};

export interface RunUsageState {
  generation?: number;
  phase?: "in-progress" | "terminal";
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  reportedCostUsd: number | null;
  tokensUnavailable: boolean;
  reportedCostUnavailable: boolean;
  tokensEstimated: boolean;
  hasAuthoritativeTokenReceipt: boolean;
}

type WritableRunUsageState = RunUsageState & {
  generation: number;
  phase: "in-progress" | "terminal";
};

const LOG_FILENAME = "gnhf.log";
const STOP_WHEN_FILENAME = "stop-when";
const COMMIT_MESSAGE_FILENAME = "commit-message";
const WORKSPACE_RECOVERY_FILENAME = "workspace-recovery.json";
const USAGE_STATE_FILENAME = "usage.json";
const RUNTIME_LIMITS_FILENAME = "runtime-limits.json";
const LOCAL_METADATA_EXCLUDES = [".gnhf/runs/", ".gnhf/setup-failures/"];

function writeSchemaFile(
  schemaPath: string,
  schemaOptions: RunSchemaOptions,
): void {
  writeFileSync(
    schemaPath,
    JSON.stringify(
      buildAgentOutputSchema({
        includeStopField: schemaOptions.includeStopField,
        commitFields: schemaOptions.commitFields,
      }),
      null,
      2,
    ),
    "utf-8",
  );
}

export interface RunSchemaOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  commitMessage?: CommitMessageConfig;
  stopWhen?: string;
  clearStopWhen?: boolean;
  runtimeLimits?: RunRuntimeLimitOverrides;
}

function resolveRunRuntimeLimits(
  runtimeLimitsPath: string,
  overrides: RunRuntimeLimitOverrides = {},
): RunRuntimeLimits {
  const runtimeLimits = readRunRuntimeLimits(runtimeLimitsPath);
  for (const key of [
    "maxIterations",
    "maxTokens",
    "maxReportedCostUsd",
  ] as const) {
    const override = overrides[key];
    if (override === undefined) {
      continue;
    }
    if (override === null) {
      delete runtimeLimits[key];
      continue;
    }
    runtimeLimits[key] = override;
  }
  if (!isRunRuntimeLimits(runtimeLimits)) {
    throw new Error(`Invalid runtime limits: ${runtimeLimitsPath}`);
  }
  writeRunRuntimeLimits(runtimeLimitsPath, runtimeLimits);
  return runtimeLimits;
}

function writeRunRuntimeLimits(
  runtimeLimitsPath: string,
  runtimeLimits: RunRuntimeLimits,
): void {
  const temporaryPath = join(
    dirname(runtimeLimitsPath),
    `.${RUNTIME_LIMITS_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(runtimeLimits, null, 2)}\n`,
      { encoding: "utf-8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryPath, runtimeLimitsPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readRunRuntimeLimits(runtimeLimitsPath: string): RunRuntimeLimits {
  if (!existsSync(runtimeLimitsPath)) {
    return {};
  }
  const value = JSON.parse(readFileSync(runtimeLimitsPath, "utf-8")) as unknown;
  if (!isRunRuntimeLimits(value)) {
    throw new Error(`Invalid runtime limits: ${runtimeLimitsPath}`);
  }
  return value;
}

function isRunRuntimeLimits(value: unknown): value is RunRuntimeLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const limits = value as Record<string, unknown>;
  if (
    Object.keys(limits).some(
      (key) =>
        key !== "maxIterations" &&
        key !== "maxTokens" &&
        key !== "maxReportedCostUsd",
    )
  ) {
    return false;
  }
  return (
    isOptionalNonNegativeInteger(limits.maxIterations) &&
    isOptionalNonNegativeInteger(limits.maxTokens) &&
    isOptionalNonNegativeFiniteNumber(limits.maxReportedCostUsd)
  );
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isOptionalNonNegativeFiniteNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function readStopWhen(stopWhenPath: string): string | undefined {
  if (!existsSync(stopWhenPath)) return undefined;
  const stopWhen = readFileSync(stopWhenPath, "utf-8").trim();
  return stopWhen.length > 0 ? stopWhen : undefined;
}

function commitMessageMetadataValue(
  commitMessage: CommitMessageConfig | undefined,
): "default" | "conventional" {
  return commitMessage?.preset ?? "default";
}

function readCommitMessageMetadata(
  commitMessagePath: string,
): CommitMessageConfig | undefined {
  const value = readFileSync(commitMessagePath, "utf-8").trim();
  if (value === "" || value === "default") return undefined;
  if (value === "conventional") return CONVENTIONAL_COMMIT_MESSAGE;
  throw new Error(`Unknown commit message metadata: ${value}`);
}

function inferCommitMessageFromSchema(
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (!existsSync(schemaPath)) return undefined;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      properties?: Record<string, unknown>;
    };
    if (
      schema.properties?.type !== undefined &&
      schema.properties.scope !== undefined
    ) {
      return CONVENTIONAL_COMMIT_MESSAGE;
    }
  } catch {
    // Legacy metadata is best-effort; malformed schemas fall back to default.
  }
  return undefined;
}

function resolveRunCommitMessage(
  commitMessagePath: string,
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (existsSync(commitMessagePath)) {
    return readCommitMessageMetadata(commitMessagePath);
  }

  const commitMessage = inferCommitMessageFromSchema(schemaPath);
  writeFileSync(
    commitMessagePath,
    `${commitMessageMetadataValue(commitMessage)}\n`,
    "utf-8",
  );
  return commitMessage;
}

function peekRunCommitMessage(
  commitMessagePath: string,
  schemaPath: string,
): CommitMessageConfig | undefined {
  if (existsSync(commitMessagePath)) {
    return readCommitMessageMetadata(commitMessagePath);
  }

  return inferCommitMessageFromSchema(schemaPath);
}

function writeCommitMessageMetadata(
  commitMessagePath: string,
  commitMessage: CommitMessageConfig | undefined,
): void {
  writeFileSync(
    commitMessagePath,
    `${commitMessageMetadataValue(commitMessage)}\n`,
    "utf-8",
  );
}

function ensureRunMetadataIgnored(cwd: string): void {
  const excludePath = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd, encoding: "utf-8" },
  ).trim();
  const resolved = isAbsolute(excludePath)
    ? excludePath
    : join(cwd, excludePath);
  mkdirSync(dirname(resolved), { recursive: true });

  if (existsSync(resolved)) {
    const content = readFileSync(resolved, "utf-8");
    const existingEntries = new Set(
      content.split("\n").map((line) => line.trim()),
    );
    const missingEntries = LOCAL_METADATA_EXCLUDES.filter(
      (entry) => !existingEntries.has(entry),
    );
    if (missingEntries.length === 0) return;
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    appendFileSync(
      resolved,
      `${separator}${missingEntries.join("\n")}\n`,
      "utf-8",
    );
  } else {
    // This ignore rule is runtime metadata, so keep it local to the clone
    // instead of mutating tracked .gitignore state on startup.
    writeFileSync(resolved, `${LOCAL_METADATA_EXCLUDES.join("\n")}\n`, "utf-8");
  }
}

export function setupRun(
  runId: string,
  prompt: string,
  baseCommit: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureRunMetadataIgnored(cwd);

  const runDir = join(cwd, ".gnhf", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const promptPath = join(runDir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf-8");

  const notesPath = join(runDir, "notes.md");
  if (!existsSync(notesPath)) {
    writeFileSync(
      notesPath,
      `# gnhf run: ${runId}\n\nObjective: see .gnhf/runs/${runId}/prompt.md\n\n## Iteration Log\n`,
      "utf-8",
    );
  }

  const schemaPath = join(runDir, "output-schema.json");
  writeSchemaFile(schemaPath, schemaOptions);

  const logPath = join(runDir, LOG_FILENAME);

  const baseCommitPath = join(runDir, "base-commit");
  const hasStoredBaseCommit = existsSync(baseCommitPath);
  const resolvedBaseCommit = hasStoredBaseCommit
    ? readFileSync(baseCommitPath, "utf-8").trim()
    : baseCommit;
  if (!hasStoredBaseCommit) {
    writeFileSync(baseCommitPath, `${baseCommit}\n`, "utf-8");
  }

  const stopWhenPath = join(runDir, STOP_WHEN_FILENAME);
  const stopWhen = schemaOptions.stopWhen;
  if (stopWhen !== undefined) {
    writeFileSync(stopWhenPath, `${stopWhen}\n`, "utf-8");
  }
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = schemaOptions.commitMessage;
  writeCommitMessageMetadata(commitMessagePath, commitMessage);
  const runtimeLimitsPath = join(runDir, RUNTIME_LIMITS_FILENAME);
  const runtimeLimits = resolveRunRuntimeLimits(
    runtimeLimitsPath,
    schemaOptions.runtimeLimits,
  );

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath,
    baseCommit: resolvedBaseCommit,
    baseCommitPath,
    stopWhenPath,
    stopWhen,
    commitMessagePath,
    commitMessage,
    runtimeLimitsPath,
    runtimeLimits,
  };
}

export function resumeRun(
  runId: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureRunMetadataIgnored(cwd);

  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const notesPath = join(runDir, "notes.md");
  for (const requiredPath of [promptPath, notesPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Incomplete run metadata: missing ${requiredPath}`);
    }
  }
  const schemaPath = join(runDir, "output-schema.json");
  const logPath = join(runDir, LOG_FILENAME);
  const baseCommitPath = join(runDir, "base-commit");
  const baseCommit = existsSync(baseCommitPath)
    ? readFileSync(baseCommitPath, "utf-8").trim()
    : backfillLegacyBaseCommit(runId, baseCommitPath, cwd);
  const stopWhenPath = join(runDir, STOP_WHEN_FILENAME);
  let stopWhen = readStopWhen(stopWhenPath);
  if (schemaOptions.clearStopWhen) {
    rmSync(stopWhenPath, { force: true });
    stopWhen = undefined;
  } else if (schemaOptions.stopWhen !== undefined) {
    stopWhen = schemaOptions.stopWhen;
    writeFileSync(stopWhenPath, `${stopWhen}\n`, "utf-8");
  }
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = resolveRunCommitMessage(commitMessagePath, schemaPath);
  const runtimeLimitsPath = join(runDir, RUNTIME_LIMITS_FILENAME);
  const runtimeLimits = resolveRunRuntimeLimits(
    runtimeLimitsPath,
    schemaOptions.runtimeLimits,
  );
  writeSchemaFile(schemaPath, {
    ...schemaOptions,
    commitMessage,
    commitFields: getCommitMessageSchemaFields(commitMessage),
    includeStopField: schemaOptions.includeStopField || stopWhen !== undefined,
  });

  return {
    runId,
    runDir,
    promptPath,
    notesPath,
    schemaPath,
    logPath,
    baseCommit,
    baseCommitPath,
    stopWhenPath,
    stopWhen,
    commitMessagePath,
    commitMessage,
    runtimeLimitsPath,
    runtimeLimits,
  };
}

export function persistRunEvidence(runInfo: RunInfo, cwd: string): RunInfo {
  const persistedRunDir = join(cwd, ".gnhf", "runs", runInfo.runId);
  if (resolve(persistedRunDir) === resolve(runInfo.runDir)) {
    return runInfo;
  }
  if (existsSync(persistedRunDir)) {
    throw new Error(`Run evidence already exists: ${persistedRunDir}`);
  }

  mkdirSync(dirname(persistedRunDir), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(persistedRunDir),
    `.${runInfo.runId}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    cpSync(runInfo.runDir, temporaryPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    renameSync(temporaryPath, persistedRunDir);
  } finally {
    rmSync(temporaryPath, { recursive: true, force: true });
  }

  return {
    ...runInfo,
    runDir: persistedRunDir,
    promptPath: join(persistedRunDir, "prompt.md"),
    notesPath: join(persistedRunDir, "notes.md"),
    schemaPath: join(persistedRunDir, "output-schema.json"),
    logPath: join(persistedRunDir, LOG_FILENAME),
    baseCommitPath: join(persistedRunDir, "base-commit"),
    stopWhenPath: join(persistedRunDir, STOP_WHEN_FILENAME),
    commitMessagePath: join(persistedRunDir, COMMIT_MESSAGE_FILENAME),
    runtimeLimitsPath: join(persistedRunDir, RUNTIME_LIMITS_FILENAME),
  };
}

export function peekRunBaseCommit(runId: string, cwd: string): string {
  const baseCommitPath = join(cwd, ".gnhf", "runs", runId, "base-commit");
  if (existsSync(baseCommitPath)) {
    return readFileSync(baseCommitPath, "utf-8").trim();
  }
  return findLegacyRunBaseCommit(runId, cwd) ?? getHeadCommit(cwd);
}

export function peekRunMetadata(runId: string, cwd: string): RunMetadata {
  const runDir = join(cwd, ".gnhf", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const promptPath = join(runDir, "prompt.md");
  const schemaPath = join(runDir, "output-schema.json");
  const commitMessagePath = join(runDir, COMMIT_MESSAGE_FILENAME);
  const commitMessage = peekRunCommitMessage(commitMessagePath, schemaPath);

  return {
    runId,
    runDir,
    promptPath,
    schemaPath,
    commitMessagePath,
    commitMessage,
  };
}

function backfillLegacyBaseCommit(
  runId: string,
  baseCommitPath: string,
  cwd: string,
): string {
  const baseCommit = peekRunBaseCommit(runId, cwd);
  writeFileSync(baseCommitPath, `${baseCommit}\n`, "utf-8");
  return baseCommit;
}

export function getLastIterationNumber(
  runInfo: Pick<RunInfo, "runDir">,
): number {
  const files = readdirSync(runInfo.runDir);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^iteration-(\d+)\.jsonl$/);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  const usageGeneration = readRunUsageState(runInfo)?.generation ?? 0;
  return Math.max(max, usageGeneration);
}

export function readWorkspaceRecovery(
  runInfo: Pick<RunInfo, "runDir">,
): WorkspaceRecovery | null {
  const recoveryPath = join(runInfo.runDir, WORKSPACE_RECOVERY_FILENAME);
  if (!existsSync(recoveryPath)) {
    return null;
  }

  const value = JSON.parse(readFileSync(recoveryPath, "utf-8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    (value.kind !== "commit-failure" && value.kind !== "interrupted") ||
    !("detail" in value) ||
    typeof value.detail !== "string"
  ) {
    throw new Error(`Invalid workspace recovery metadata: ${recoveryPath}`);
  }
  return { kind: value.kind, detail: value.detail };
}

export function writeWorkspaceRecovery(
  runInfo: Pick<RunInfo, "runDir">,
  recovery: WorkspaceRecovery,
): void {
  const recoveryPath = join(runInfo.runDir, WORKSPACE_RECOVERY_FILENAME);
  const temporaryPath = join(
    runInfo.runDir,
    `.${WORKSPACE_RECOVERY_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(recovery, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, recoveryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function clearWorkspaceRecovery(runInfo: Pick<RunInfo, "runDir">): void {
  rmSync(join(runInfo.runDir, WORKSPACE_RECOVERY_FILENAME), { force: true });
}

export function readRunUsageState(
  runInfo: Pick<RunInfo, "runDir">,
): RunUsageState | null {
  const usagePath = join(runInfo.runDir, USAGE_STATE_FILENAME);
  if (!existsSync(usagePath)) {
    return null;
  }

  const value = JSON.parse(readFileSync(usagePath, "utf-8")) as unknown;
  if (!isRunUsageState(value)) {
    throw new Error(`Invalid run usage metadata: ${usagePath}`);
  }
  return value;
}

export function writeRunUsageState(
  runInfo: Pick<RunInfo, "runDir">,
  usageState: WritableRunUsageState,
): void {
  const usagePath = join(runInfo.runDir, USAGE_STATE_FILENAME);
  const temporaryPath = join(
    runInfo.runDir,
    `.${USAGE_STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(usageState, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, usagePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function isRunUsageState(value: unknown): value is RunUsageState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    hasValidUsageGeneration(state) &&
    isNonNegativeFiniteNumber(state.totalInputTokens) &&
    isNonNegativeFiniteNumber(state.totalOutputTokens) &&
    isNonNegativeFiniteNumber(state.totalTokens) &&
    (state.reportedCostUsd === null ||
      isNonNegativeFiniteNumber(state.reportedCostUsd)) &&
    typeof state.tokensUnavailable === "boolean" &&
    typeof state.reportedCostUnavailable === "boolean" &&
    typeof state.tokensEstimated === "boolean" &&
    typeof state.hasAuthoritativeTokenReceipt === "boolean"
  );
}

function hasValidUsageGeneration(state: Record<string, unknown>): boolean {
  if (state.generation === undefined && state.phase === undefined) {
    return true;
  }

  return (
    isNonNegativeFiniteNumber(state.generation) &&
    Number.isInteger(state.generation) &&
    (state.phase === "in-progress" || state.phase === "terminal")
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // Not JSON — fall through to render raw
    }
    return [value];
  }
  return [];
}

function formatListSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `**${title}:**\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

export function appendNotes(
  notesPath: string,
  iteration: number,
  summary: string,
  changes: string[],
  learnings: string[],
): void {
  const entry = [
    `\n### Iteration ${iteration}\n`,
    `**Summary:** ${summary}\n`,
    formatListSection("Changes", changes),
    formatListSection("Learnings", learnings),
  ].join("\n");

  appendFileSync(notesPath, entry, "utf-8");
}
