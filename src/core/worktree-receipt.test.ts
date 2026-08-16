import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

    const receiptId = writeConfiguredWorktreeReceipt({
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      environment: { GNHF_WORKTREE_RECEIPT_PATH: receiptPath },
      state: "created",
      worktreePath: join(directory, "worktree"),
    });

    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({
      schemaVersion: 1,
      receiptId,
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      state: "created",
      worktreePath: join(directory, "worktree"),
    });
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
  });

  it("publishes worktree identity without reading optional run metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "gnhf-worktree-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "worktree.json");

    writeConfiguredWorktreeReceipt({
      runId: "fixture-run",
      environment: { GNHF_WORKTREE_RECEIPT_PATH: receiptPath },
      state: "created",
      worktreePath: join(directory, "worktree"),
    });

    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toMatchObject({
      schemaVersion: 1,
      runId: "fixture-run",
      state: "created",
      worktreePath: join(directory, "worktree"),
    });
  });

  it("atomically finalizes a claimed pending identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "gnhf-worktree-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "worktree.json");
    const environment = { GNHF_WORKTREE_RECEIPT_PATH: receiptPath };
    const worktreePath = join(directory, "worktree");
    const receiptId = writeConfiguredWorktreeReceipt({
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      environment,
      state: "pending",
      worktreePath,
    });
    expect(receiptId).toEqual(expect.any(String));

    writeConfiguredWorktreeReceipt({
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      environment,
      receiptId: receiptId!,
      state: "created",
      worktreePath,
    });

    expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({
      schemaVersion: 1,
      receiptId,
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      state: "created",
      worktreePath,
    });
    expect(readdirSync(directory)).toEqual(["worktree.json"]);
  });

  it("refuses to replace an existing receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "gnhf-worktree-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "worktree.json");
    const params = {
      runId: "fixture-run",
      baseCommit: "a".repeat(40),
      environment: { GNHF_WORKTREE_RECEIPT_PATH: receiptPath },
      state: "pending" as const,
      worktreePath: join(directory, "worktree"),
    };

    writeFileSync(receiptPath, "original\n", { mode: 0o600 });

    expect(() => writeConfiguredWorktreeReceipt(params)).toThrow();
    expect(readFileSync(receiptPath, "utf-8")).toBe("original\n");
    expect(readdirSync(directory)).toEqual(["worktree.json"]);
  });
});
