import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentResult } from "./agents/types.js";
import type { Config } from "./config.js";
import { resetDebugLogForTests } from "./debug-log.js";
import { Orchestrator } from "./orchestrator.js";
import type { RunInfo } from "./run.js";
import { getWorktreePreservationReason } from "./worktree-preservation.js";

const config: Config = {
  agent: "claude",
  agentPathOverride: {},
  agentArgsOverride: {},
  acpRegistryOverrides: {},
  maxConsecutiveFailures: 3,
  preventSleep: false,
};

describe("forced-stop preservation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetDebugLogForTests();
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves dirty work from an interrupted iteration", async () => {
    const fixture = createFixture();
    const agent: Agent = {
      name: "claude",
      run: vi.fn((_prompt, cwd, options) => {
        writeFileSync(join(cwd, "result.txt"), "unfinished\n", "utf-8");
        return new Promise<AgentResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("Agent was aborted"));
          });
        });
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      fixture.runInfo,
      "ship it",
      fixture.cwd,
      0,
      { preserveWorkspaceOnForceStop: true },
    );

    const startPromise = orchestrator.start();
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(1);
    });
    orchestrator.stop();
    await startPromise;

    expect(existsSync(join(fixture.cwd, "result.txt"))).toBe(true);
    expect(
      getWorktreePreservationReason(fixture.baseCommit, fixture.cwd, false),
    ).toBe("dirty");

    const recoveryAgent: Agent = {
      name: "claude",
      run: vi.fn().mockRejectedValue(new Error("network unavailable")),
    };
    const resumedOrchestrator = new Orchestrator(
      config,
      recoveryAgent,
      fixture.runInfo,
      "ship it",
      fixture.cwd,
      0,
      { maxIterations: 1, preserveWorkspaceOnForceStop: true },
    );

    await resumedOrchestrator.start();

    expect(recoveryAgent.run).toHaveBeenCalledWith(
      expect.stringContaining("Interrupted Workspace Recovery"),
      fixture.cwd,
      expect.any(Object),
    );
    expect(existsSync(join(fixture.cwd, "result.txt"))).toBe(true);
    expect(resumedOrchestrator.getState().hasPendingWorkspaceRecovery).toBe(
      true,
    );
  });

  it("preserves pending commit-repair work after force stop", async () => {
    const fixture = createFixture();
    const gitDirectory = git(fixture.cwd, ["rev-parse", "--git-dir"]);
    const hookPath = join(fixture.cwd, gitDirectory, "hooks", "pre-commit");
    mkdirSync(join(fixture.cwd, gitDirectory, "hooks"), { recursive: true });
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const agent: Agent = {
      name: "claude",
      run: vi
        .fn()
        .mockImplementationOnce((_prompt, cwd) => {
          writeFileSync(join(cwd, "result.txt"), "needs repair\n", "utf-8");
          return Promise.resolve(successResult());
        })
        .mockImplementationOnce(
          (_prompt, _cwd, options) =>
            new Promise<AgentResult>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                reject(new Error("Agent was aborted"));
              });
            }),
        ),
      close: vi.fn(() => Promise.resolve()),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      fixture.runInfo,
      "ship it",
      fixture.cwd,
      0,
      { preserveWorkspaceOnForceStop: true },
    );

    const startPromise = orchestrator.start();
    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledTimes(2);
    });
    expect(orchestrator.getState().hasPendingCommitFailure).toBe(true);
    orchestrator.stop();
    await startPromise;

    expect(orchestrator.getState().hasPendingCommitFailure).toBe(true);
    expect(
      getWorktreePreservationReason(fixture.baseCommit, fixture.cwd, true),
    ).toBe("pending-recovery");
    expect(existsSync(join(fixture.cwd, "result.txt"))).toBe(true);
  });

  it("preserves a commit when notes persistence fails", async () => {
    const fixture = createFixture();
    rmSync(fixture.runInfo.notesPath);
    mkdirSync(fixture.runInfo.notesPath);
    const agent: Agent = {
      name: "claude",
      run: vi.fn((_prompt, cwd) => {
        writeFileSync(join(cwd, "result.txt"), "committed\n", "utf-8");
        return Promise.resolve(successResult());
      }),
    };
    const orchestrator = new Orchestrator(
      config,
      agent,
      fixture.runInfo,
      "ship it",
      fixture.cwd,
      0,
      { maxIterations: 1 },
    );

    await expect(orchestrator.start()).rejects.toThrow();

    expect(
      getWorktreePreservationReason(fixture.baseCommit, fixture.cwd, false),
    ).toBe("committed");
    expect(
      git(fixture.cwd, ["rev-list", "--count", `${fixture.baseCommit}..HEAD`]),
    ).toBe("1");
  });

  function createFixture(): {
    baseCommit: string;
    cwd: string;
    runInfo: RunInfo;
  } {
    const root = mkdtempSync(join(tmpdir(), "gnhf-force-preservation-"));
    tempDirs.push(root);
    const cwd = join(root, "repo");
    const runDirectory = join(root, "metadata", "run");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, "notes.md"), "# Notes\n", "utf-8");

    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.name", "gnhf tests"]);
    git(cwd, ["config", "user.email", "tests@example.com"]);
    writeFileSync(join(cwd, "README.md"), "fixture\n", "utf-8");
    git(cwd, ["add", "README.md"]);
    git(cwd, ["commit", "-m", "init"]);
    const baseCommit = git(cwd, ["rev-parse", "HEAD"]);
    const runInfo: RunInfo = {
      runId: "run",
      runDir: runDirectory,
      promptPath: join(runDirectory, "prompt.md"),
      notesPath: join(runDirectory, "notes.md"),
      schemaPath: join(runDirectory, "output-schema.json"),
      logPath: join(runDirectory, "gnhf.log"),
      baseCommit,
      baseCommitPath: join(runDirectory, "base-commit"),
      stopWhenPath: join(runDirectory, "stop-when"),
      stopWhen: undefined,
      commitMessagePath: join(runDirectory, "commit-message"),
      commitMessage: undefined,
    };
    return { baseCommit, cwd, runInfo };
  }

  function git(cwd: string, arguments_: string[]): string {
    return execFileSync("git", arguments_, {
      cwd,
      encoding: "utf-8",
    }).trim();
  }

  function successResult(): AgentResult {
    return {
      output: {
        success: true,
        summary: "done",
        key_changes_made: ["result.txt"],
        key_learnings: [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
  }
});
