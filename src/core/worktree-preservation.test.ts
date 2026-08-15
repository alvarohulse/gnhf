import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorktreePreservationReason } from "./worktree-preservation.js";

describe("getWorktreePreservationReason", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves work committed after the run base", () => {
    const cwd = createRepo();
    const baseCommit = git(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "result.txt"), "done\n", "utf-8");
    git(cwd, ["add", "result.txt"]);
    git(cwd, ["commit", "-m", "result"]);

    expect(getWorktreePreservationReason(baseCommit, cwd, false)).toBe(
      "committed",
    );
  });

  it("preserves uncommitted work when no commit was created", () => {
    const cwd = createRepo();
    const baseCommit = git(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "result.txt"), "unfinished\n", "utf-8");

    expect(getWorktreePreservationReason(baseCommit, cwd, false)).toBe("dirty");
  });

  it("preserves a clean worktree while commit repair is pending", () => {
    const cwd = createRepo();
    const baseCommit = git(cwd, ["rev-parse", "HEAD"]);

    expect(getWorktreePreservationReason(baseCommit, cwd, true)).toBe(
      "pending-commit",
    );
  });

  it("preserves when Git cannot inspect the run base", () => {
    const cwd = createRepo();

    expect(getWorktreePreservationReason("missing-base", cwd, false)).toBe(
      "uncertain",
    );
  });

  it("preserves when the run base is empty or malformed", () => {
    const cwd = createRepo();

    expect(getWorktreePreservationReason("", cwd, false)).toBe("uncertain");
    expect(
      getWorktreePreservationReason("not-a-full-object-id", cwd, false),
    ).toBe("uncertain");
  });

  it("allows cleanup for a clean zero-commit worktree", () => {
    const cwd = createRepo();
    const baseCommit = git(cwd, ["rev-parse", "HEAD"]);

    expect(getWorktreePreservationReason(baseCommit, cwd, false)).toBeNull();
  });

  function createRepo(): string {
    const cwd = mkdtempSync(join(tmpdir(), "gnhf-preservation-"));
    tempDirs.push(cwd);
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.name", "gnhf tests"]);
    git(cwd, ["config", "user.email", "tests@example.com"]);
    writeFileSync(join(cwd, "README.md"), "# fixture\n", "utf-8");
    git(cwd, ["add", "README.md"]);
    git(cwd, ["commit", "-m", "init"]);
    return cwd;
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  }
});
