import { getBranchCommitCount, hasWorkingTreeChanges } from "./git.js";

export type WorktreePreservationReason =
  | "committed"
  | "dirty"
  | "forced-shutdown"
  | "pending-recovery"
  | "uncertain";

export function getWorktreePreservationReason(
  baseCommit: string,
  cwd: string,
  hasPendingWorkspaceRecovery: boolean,
  forceShutdownRequested = false,
): WorktreePreservationReason | null {
  if (forceShutdownRequested) {
    return "forced-shutdown";
  }
  if (hasPendingWorkspaceRecovery) {
    return "pending-recovery";
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit)) {
    return "uncertain";
  }

  try {
    if (getBranchCommitCount(baseCommit, cwd) > 0) {
      return "committed";
    }
    if (hasWorkingTreeChanges(cwd)) {
      return "dirty";
    }
  } catch {
    return "uncertain";
  }

  return null;
}
