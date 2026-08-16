import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChildProcessShutdownTracker,
  shouldDetachAgentProcess,
  shutdownChildProcess,
  shutdownWindowsProcessTree,
  signalChildProcess,
  spawnManagedChildProcess,
} from "./managed-process.js";

function createChildProcess(pid = 1234): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    pid,
    kill: vi.fn((signal: number | NodeJS.Signals | undefined) => {
      void signal;
      return true as const;
    }),
    signalCode: null,
  }) as unknown as ChildProcess;
}

describe("shouldDetachAgentProcess", () => {
  it("keeps agents inside an external supervisor process group", () => {
    expect(shouldDetachAgentProcess("linux", true)).toBe(false);
  });

  it("creates an owned process group for unsupervised Unix agents", () => {
    expect(shouldDetachAgentProcess("linux", false)).toBe(true);
  });

  it("does not detach Windows agents", () => {
    expect(shouldDetachAgentProcess("win32", false)).toBe(false);
  });
});

describe("ChildProcessShutdownTracker", () => {
  it("waits for retained shutdowns", async () => {
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const tracker = new ChildProcessShutdownTracker();
    let finished = false;

    tracker.start(() => shutdown);
    const wait = tracker.waitForAll().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    resolveShutdown();
    await wait;
    expect(finished).toBe(true);
  });

  it("retains shutdown failures until a waiter observes them", async () => {
    const tracker = new ChildProcessShutdownTracker();
    tracker.start(() =>
      Promise.reject(new Error("process cleanup was not proven")),
    );
    await Promise.resolve();
    await Promise.resolve();

    await expect(tracker.waitForAll()).rejects.toThrow(
      "process cleanup was not proven",
    );
  });
});

describe("signalChildProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signals the process group for detached children", () => {
    const child = createChildProcess();
    const killProcess = vi.fn();

    signalChildProcess(child, {
      detached: true,
      killProcess,
      signal: "SIGTERM",
    });

    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to killing the direct child when process-group signaling fails", () => {
    const child = createChildProcess();
    const killProcess = vi.fn(() => {
      throw new Error("group kill failed");
    });

    signalChildProcess(child, {
      detached: true,
      killProcess,
      signal: "SIGTERM",
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("spawnManagedChildProcess", () => {
  it("places detached commands behind a stable process-group supervisor", () => {
    const supervisor = Object.assign(createChildProcess(), {
      stdin: new EventEmitter(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(),
    });
    const spawnProcess = vi.fn(() => supervisor);

    const child = spawnManagedChildProcess(
      spawnProcess,
      "agent-cli",
      ["--json"],
      {
        cwd: "/repo",
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        "-e",
        expect.stringContaining('process.on("SIGTERM", () => {})'),
        "--",
        "agent-cli",
        "--json",
      ],
      expect.objectContaining({
        cwd: "/repo",
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      }),
    );
    expect(child.pid).toBe(supervisor.pid);
  });

  it.runIf(process.platform !== "win32")(
    "settles with the target status after supervised group cleanup",
    async () => {
      const child = spawnManagedChildProcess(
        spawn,
        process.execPath,
        ["-e", 'process.stdout.write("supervised")'],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });

      expect(result).toEqual({ code: 0, signal: null });
      expect(stdout).toBe("supervised");
    },
    5_000,
  );

  it("tracks target-close shutdowns until cleanup completes", async () => {
    vi.useFakeTimers();
    const supervisor = Object.assign(createChildProcess(), {
      stdin: new EventEmitter(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      send: vi.fn(),
    });
    const spawnProcess = vi.fn(() => supervisor);
    const tracker = new ChildProcessShutdownTracker();
    let groupPresent = true;
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === 0 && !groupPresent) {
          throw Object.assign(new Error("process group exited"), {
            code: "ESRCH",
          });
        }
        if (signal === "SIGKILL") {
          queueMicrotask(() => supervisor.emit("close", 0, "SIGKILL"));
        }
        return true;
      });

    try {
      spawnManagedChildProcess(
        spawnProcess,
        "agent-cli",
        ["--json"],
        {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
        tracker,
      );
      supervisor.emit("message", {
        type: "target-close",
        code: 0,
        signal: null,
      });

      let cleanupComplete = false;
      const cleanup = tracker.waitForAll().then(() => {
        cleanupComplete = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupComplete).toBe(false);

      groupPresent = false;
      await vi.advanceTimersByTimeAsync(100);
      await cleanup;
      expect(cleanupComplete).toBe(true);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("shutdownChildProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("force kills the child when graceful shutdown times out", async () => {
    const child = createChildProcess();
    vi.mocked(child.kill).mockImplementation(
      (signal?: number | NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => {
            child.emit("close", 0, null);
          });
        }
        return true as const;
      },
    );

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await closePromise;
    vi.useRealTimers();
  });

  it("waits for close after sending SIGKILL", async () => {
    const child = createChildProcess();
    let resolved = false;

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    }).then(() => {
      resolved = true;
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.emit("close", 0, null);
    await closePromise;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it("surfaces incomplete cleanup if the child never closes", async () => {
    const child = createChildProcess();

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });
    const rejection = expect(closePromise).rejects.toThrow(
      "Could not prove process cleanup completed",
    );

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });

  it("clears the force-kill timer when the child closes first", async () => {
    const child = createChildProcess();

    const closePromise = shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", 0, null);
    await closePromise;

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });

  it("does not escalate an owned group after the leader closes", async () => {
    const child = createChildProcess();
    const killProcess = vi.fn(() => true as const);

    const closePromise = shutdownChildProcess(child, {
      detached: true,
      killProcess,
      timeoutMs: 3_000,
    });

    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGTERM");
    const rejection = expect(closePromise).rejects.toThrow(
      "Could not prove process cleanup completed",
    );
    child.emit("close", 0, null);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(killProcess).not.toHaveBeenCalledWith(-1234, "SIGKILL");
    vi.useRealTimers();
  });

  it("stops escalation after the owned process group disappears", async () => {
    const child = createChildProcess();
    const killProcess = vi.fn(
      (_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0) {
          throw Object.assign(new Error("process group no longer exists"), {
            code: "ESRCH",
          });
        }
        return true as const;
      },
    );

    const closePromise = shutdownChildProcess(child, {
      detached: true,
      killProcess,
      timeoutMs: 3_000,
    });

    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGTERM");
    child.emit("close", 0, null);

    await vi.advanceTimersByTimeAsync(3_000);
    await closePromise;

    expect(killProcess).toHaveBeenCalledWith(-1234, 0);
    expect(killProcess).not.toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("does not signal a recycled group after the initial group signal fails", async () => {
    const child = createChildProcess();
    const killProcess = vi.fn(
      (_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === "SIGTERM") {
          throw Object.assign(new Error("process group no longer exists"), {
            code: "ESRCH",
          });
        }
        return true as const;
      },
    );

    const closePromise = shutdownChildProcess(child, {
      detached: true,
      killProcess,
      timeoutMs: 3_000,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    const rejection = expect(closePromise).rejects.toThrow(
      "Could not prove process cleanup completed",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;

    expect(killProcess).not.toHaveBeenCalledWith(-1234, "SIGKILL");
    vi.useRealTimers();
  });

  it("rejects when the group remains after successful SIGKILL delivery", async () => {
    const child = createChildProcess();
    const killProcess = vi.fn(
      (_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => child.emit("close", 0, "SIGKILL"));
        }
        return true as const;
      },
    );

    const closePromise = shutdownChildProcess(child, {
      detached: true,
      killProcess,
      timeoutMs: 3_000,
    });
    const rejection = expect(closePromise).rejects.toThrow(
      "Could not prove process cleanup completed",
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGKILL");
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(killProcess).toHaveBeenCalledWith(-1234, 0);
    vi.useRealTimers();
  });

  it("shares concurrent shutdown supervision", async () => {
    const child = createChildProcess();
    let groupPresent = true;
    const killProcess = vi.fn(
      (_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          groupPresent = false;
          queueMicrotask(() => child.emit("close", 0, "SIGKILL"));
        }
        if (signal === 0 && !groupPresent) {
          throw Object.assign(new Error("process group exited"), {
            code: "ESRCH",
          });
        }
        return true as const;
      },
    );

    const firstShutdown = shutdownChildProcess(child, {
      detached: true,
      killProcess,
      timeoutMs: 3_000,
    });
    const secondShutdown = shutdownChildProcess(child, {
      detached: true,
      killProcess,
      timeoutMs: 3_000,
    });

    expect(secondShutdown).toBe(firstShutdown);
    expect(killProcess).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([firstShutdown, secondShutdown]);
    expect(killProcess).toHaveBeenCalledTimes(3);
    expect(killProcess).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(killProcess).toHaveBeenCalledWith(-1234, 0);
    vi.useRealTimers();
  });

  it("resolves immediately when the child has already exited", async () => {
    const child = Object.assign(createChildProcess(), {
      exitCode: 0,
    });

    await shutdownChildProcess(child, {
      detached: false,
      timeoutMs: 3_000,
    });

    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });
});

describe("shutdownWindowsProcessTree", () => {
  it("waits for the exact child to close after taskkill succeeds", async () => {
    const child = createChildProcess();
    const killTree = vi.fn();
    let cleanupComplete = false;

    const cleanup = shutdownWindowsProcessTree(child, { killTree }).then(() => {
      cleanupComplete = true;
    });

    expect(killTree).toHaveBeenCalledWith(1234);
    await Promise.resolve();
    expect(cleanupComplete).toBe(false);

    child.emit("close", 0, null);
    await cleanup;
    expect(cleanupComplete).toBe(true);
  });

  it("rejects taskkill failure while the exact child remains live", async () => {
    const child = createChildProcess();
    const killTree = vi.fn(() => {
      throw new Error("access denied");
    });

    await expect(
      shutdownWindowsProcessTree(child, { killTree }),
    ).rejects.toThrow("Could not prove process cleanup completed");
  });
});
