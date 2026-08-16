import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type WriteConfiguredWorktreeReceiptParams = {
  runId: string;
  baseCommit?: string;
  environment?: NodeJS.ProcessEnv;
  worktreePath: string;
};

type WorktreeReceipt = {
  schemaVersion: 1;
  runId: string;
  baseCommit?: string;
  worktreePath: string;
};

export function writeConfiguredWorktreeReceipt({
  runId,
  baseCommit,
  environment = process.env,
  worktreePath,
}: WriteConfiguredWorktreeReceiptParams): void {
  const configuredPath = environment.GNHF_WORKTREE_RECEIPT_PATH;
  if (configuredPath === undefined) {
    return;
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error("GNHF_WORKTREE_RECEIPT_PATH must be absolute");
  }

  const receipt: WorktreeReceipt = {
    schemaVersion: 1,
    runId,
    worktreePath: resolve(worktreePath),
  };
  if (baseCommit !== undefined) {
    receipt.baseCommit = baseCommit;
  }

  const directory = dirname(configuredPath);
  const temporaryPath = join(
    directory,
    `.${basename(configuredPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let published = false;
  try {
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

    linkSync(temporaryPath, configuredPath);
    published = true;
    unlinkSync(temporaryPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (published) {
      unlinkIfPresent(configuredPath);
    }
    unlinkIfPresent(temporaryPath);
    if (published) {
      fsyncDirectory(directory);
    }
    throw error;
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
