import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RunInfo } from "./run.js";

type WriteConfiguredWorktreeReceiptParams = {
  environment?: NodeJS.ProcessEnv;
  runInfo: RunInfo;
  worktreePath: string;
};

export function writeConfiguredWorktreeReceipt({
  environment = process.env,
  runInfo,
  worktreePath,
}: WriteConfiguredWorktreeReceiptParams): void {
  const configuredPath = environment.GNHF_WORKTREE_RECEIPT_PATH;
  if (configuredPath === undefined) {
    return;
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error("GNHF_WORKTREE_RECEIPT_PATH must be absolute");
  }

  const descriptor = openSync(
    configuredPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: runInfo.runId,
          baseCommit: runInfo.baseCommit,
          worktreePath: resolve(worktreePath),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
