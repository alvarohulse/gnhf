import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfiguredWorktreeReceipt } from "./worktree-receipt.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("writeConfiguredWorktreeReceipt", () => {
  it("writes an owner-only durable receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "gnhf-worktree-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "worktree.json");

    writeConfiguredWorktreeReceipt({
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      environment: { GNHF_WORKTREE_RECEIPT_PATH: receiptPath },
      worktreePath: join(directory, "worktree"),
    });

    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({
      schemaVersion: 1,
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      worktreePath: join(directory, "worktree"),
    });
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace an existing receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "gnhf-worktree-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "worktree.json");
    const params = {
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      environment: { GNHF_WORKTREE_RECEIPT_PATH: receiptPath },
      worktreePath: join(directory, "worktree"),
    };

    writeConfiguredWorktreeReceipt(params);

    expect(() => writeConfiguredWorktreeReceipt(params)).toThrow();
  });
});
