import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type WorktreeReceiptDisposition = "preserved" | "removed";

type WriteConfiguredWorktreeReceiptParams = {
  runId: string;
  baseCommit?: string;
  environment?: NodeJS.ProcessEnv;
  receiptId?: string;
  worktreePath: string;
} & (
  | { state: "created" | "pending" }
  | {
      state: "shutdown";
      disposition: WorktreeReceiptDisposition;
      preservationReason?: string;
    }
);

type WorktreeReceipt = {
  schemaVersion: 1;
  receiptId: string;
  runId: string;
  baseCommit?: string;
  disposition?: WorktreeReceiptDisposition;
  preservationReason?: string;
  state: "created" | "pending" | "shutdown";
  worktreePath: string;
};

export function writeConfiguredWorktreeReceipt(
  params: WriteConfiguredWorktreeReceiptParams,
): string | undefined {
  const {
    runId,
    baseCommit,
    environment = process.env,
    receiptId,
    state,
    worktreePath,
  } = params;
  const configuredPath = environment.GNHF_WORKTREE_RECEIPT_PATH;
  if (configuredPath === undefined) {
    return undefined;
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error("GNHF_WORKTREE_RECEIPT_PATH must be absolute");
  }

  const activeReceiptId = receiptId ?? randomUUID();
  const receipt: WorktreeReceipt = {
    schemaVersion: 1,
    receiptId: activeReceiptId,
    runId,
    state,
    worktreePath: resolve(worktreePath),
  };
  if (baseCommit !== undefined) {
    receipt.baseCommit = baseCommit;
  }
  if (state === "shutdown") {
    receipt.disposition = params.disposition;
    if (params.preservationReason !== undefined) {
      receipt.preservationReason = params.preservationReason;
    }
  }

  const directory = dirname(configuredPath);
  const temporaryPath = join(
    directory,
    `.${basename(configuredPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    withReceiptLock(configuredPath, () => {
      const descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(
          descriptor,
          `${JSON.stringify(receipt, null, 2)}\n`,
          "utf-8",
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }

      if (receiptId === undefined) {
        linkSync(temporaryPath, configuredPath);
        unlinkSync(temporaryPath);
      } else {
        assertReceiptOwnership(configuredPath, receiptId);
        renameSync(temporaryPath, configuredPath);
      }
      fsyncDirectory(directory);
    });
    return activeReceiptId;
  } catch (error) {
    unlinkIfPresent(temporaryPath);
    throw error;
  }
}

function withReceiptLock<T>(configuredPath: string, action: () => T): T {
  const directory = dirname(configuredPath);
  const lockPath = join(directory, `.${basename(configuredPath)}.lock`);
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Configured worktree receipt is being updated");
    }
    throw error;
  }

  try {
    return action();
  } finally {
    rmdirSync(lockPath);
    fsyncDirectory(directory);
  }
}

function assertReceiptOwnership(path: string, receiptId: string): void {
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error("Configured worktree receipt is not owned by this run");
  }
  if (
    typeof existing !== "object" ||
    existing === null ||
    !("receiptId" in existing) ||
    existing.receiptId !== receiptId
  ) {
    throw new Error("Configured worktree receipt is not owned by this run");
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") {
    return;
  }
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
