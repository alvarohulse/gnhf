import { getBranchCommitCount, hasWorkingTreeChanges } from "./git.js";

export type WorktreePreservationReason =
  | "committed"
  | "dirty"
  | "pending-commit"
  | "uncertain";

export function getWorktreePreservationReason(
  baseCommit: string,
  cwd: string,
  hasPendingCommitFailure: boolean,
): WorktreePreservationReason | null {
  if (hasPendingCommitFailure) {
    return "pending-commit";
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
