import {
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { IncompleteAgentShutdownError } from "./types.js";

interface SignalChildProcessOptions {
  detached: boolean;
  killProcess?: typeof process.kill;
  signal: NodeJS.Signals;
}

interface ShutdownChildProcessOptions {
  detached: boolean;
  killProcess?: typeof process.kill;
  timeoutMs?: number;
}

interface ShutdownWindowsProcessTreeOptions {
  killTree?: (pid: number) => void;
  ownershipLost?: boolean;
  timeoutMs?: number;
}

const SHUTDOWN_CONFIRMATION_GRACE_MS = 100;
const activeShutdowns = new WeakMap<ChildProcess, Promise<void>>();
const activeWindowsTreeShutdowns = new WeakMap<ChildProcess, Promise<void>>();
const closedWindowsProcessTrees = new WeakSet<ChildProcess>();
const closedOwnedProcessGroupLeaders = new WeakSet<ChildProcess>();
const PROCESS_TREE_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const [shellFlag, command, ...args] = process.argv.slice(1);
process.on("SIGTERM", () => {});
process.on("disconnect", () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
});
const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000);
const target = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: shellFlag === "1",
  stdio: "inherit",
});
target.once("error", (error) => {
  process.send?.({ type: "target-error", message: error.message });
});
target.once("close", (code, signal) => {
  process.send?.({ type: "target-close", code, signal });
});
process.once("exit", () => clearInterval(keepAlive));
`;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type SupervisorMessage =
  | { type: "target-close"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "target-error"; message: string };

function isSupervisorMessage(value: unknown): value is SupervisorMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "target-error") {
    return "message" in value && typeof value.message === "string";
  }
  return (
    value.type === "target-close" &&
    "code" in value &&
    (value.code === null || typeof value.code === "number") &&
    "signal" in value &&
    (value.signal === null || typeof value.signal === "string")
  );
}

export class IncompleteChildProcessShutdownError extends IncompleteAgentShutdownError {
  constructor(pid: number | undefined) {
    super(
      `Could not prove process cleanup completed${pid === undefined ? "" : ` for PID ${pid}`}`,
    );
    this.name = "IncompleteChildProcessShutdownError";
  }
}

export function spawnManagedChildProcess(
  spawnProcess: SpawnProcess,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  shutdownTracker?: ChildProcessShutdownTracker,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const ownsProcessTree = options.detached === true || platform === "win32";
  if (!ownsProcessTree) {
    return spawnProcess(command, args, options);
  }

  const input = Array.isArray(options.stdio)
    ? options.stdio[0]
    : (options.stdio ?? "pipe");
  const supervisor = spawnProcess(
    process.execPath,
    [
      "-e",
      PROCESS_TREE_SUPERVISOR_SOURCE,
      "--",
      options.shell === true ? "1" : "0",
      command,
      ...args,
    ],
    {
      ...options,
      shell: false,
      stdio: [input, "pipe", "pipe", "ipc"],
    },
  );
  if (typeof supervisor.send !== "function") {
    return supervisor;
  }

  const managed = Object.assign(new EventEmitter(), {
    stdin: supervisor.stdin,
    stdout: supervisor.stdout,
    stderr: supervisor.stderr,
    pid: supervisor.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill(signal?: number | NodeJS.Signals): boolean {
      managed.killed = true;
      return supervisor.kill(signal);
    },
  });
  let targetStatus: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  let settled = false;

  const startManagedShutdown = (ownershipLost = false) => {
    const startShutdown = () =>
      platform === "win32"
        ? shutdownWindowsProcessTree(managed as unknown as ChildProcess, {
            ownershipLost,
          })
        : shutdownChildProcess(managed as unknown as ChildProcess, {
            detached: true,
            timeoutMs: 0,
          });
    return shutdownTracker?.start(startShutdown) ?? startShutdown();
  };

  supervisor.on("message", (message: unknown) => {
    if (!isSupervisorMessage(message)) {
      return;
    }
    if (message.type === "target-error") {
      void startManagedShutdown().catch((error: unknown) => {
        managed.emit(
          "error",
          error instanceof Error
            ? error
            : new IncompleteChildProcessShutdownError(managed.pid),
        );
      });
      managed.emit("error", new Error(message.message));
      return;
    }
    targetStatus = { code: message.code, signal: message.signal };
    void startManagedShutdown(platform === "win32").catch((error: unknown) => {
      managed.emit(
        "error",
        error instanceof Error
          ? error
          : new IncompleteChildProcessShutdownError(managed.pid),
      );
    });
  });
  supervisor.on("error", (error) => managed.emit("error", error));
  supervisor.on("close", (code, signal) => {
    if (settled) {
      return;
    }
    settled = true;
    managed.exitCode = targetStatus !== null ? targetStatus.code : code;
    managed.signalCode = targetStatus !== null ? targetStatus.signal : signal;
    managed.emit("close", managed.exitCode, managed.signalCode);
  });

  return managed as unknown as ChildProcess;
}

export class ChildProcessShutdownTracker {
  private pending = new Set<Promise<void>>();
  private failure: unknown = null;

  start(startShutdown: () => Promise<void>): Promise<void> {
    let shutdown: Promise<void>;
    try {
      shutdown = startShutdown();
    } catch (error) {
      shutdown = Promise.reject(error);
    }
    this.pending.add(shutdown);
    void shutdown.then(
      () => this.pending.delete(shutdown),
      (error) => {
        this.pending.delete(shutdown);
        this.failure ??= error;
      },
    );
    return shutdown;
  }

  async waitForAll(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
    if (this.failure !== null) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
  }

  acknowledgeFailure(error: unknown): void {
    if (this.failure === error) {
      this.failure = null;
    }
  }

  async finalizeOwnedProcessGroup(
    child: ChildProcess,
    detached: boolean,
    startShutdown: () => Promise<void>,
  ): Promise<void> {
    if (!detached || child.pid === undefined) {
      await this.waitForAll();
      return;
    }
    closedOwnedProcessGroupLeaders.add(child);
    await this.start(startShutdown);
  }
}

export function shouldDetachAgentProcess(
  platform: NodeJS.Platform,
  supervisedProcessGroup = process.env.GNHF_SUPERVISED_PROCESS_GROUP === "1",
): boolean {
  return platform !== "win32" && !supervisedProcessGroup;
}

export function signalChildProcess(
  child: ChildProcess,
  options: SignalChildProcessOptions,
): void {
  const killProcess = options.killProcess ?? process.kill.bind(process);

  if (
    options.detached &&
    child.pid &&
    child.exitCode === null &&
    child.signalCode === null &&
    !closedOwnedProcessGroupLeaders.has(child)
  ) {
    try {
      killProcess(-child.pid, options.signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }

  child.kill(options.signal);
}

export function shutdownWindowsProcessTree(
  child: ChildProcess,
  options: ShutdownWindowsProcessTreeOptions = {},
): Promise<void> {
  const activeShutdown = activeWindowsTreeShutdowns.get(child);
  if (activeShutdown) {
    return activeShutdown;
  }
  if (closedWindowsProcessTrees.has(child)) {
    return Promise.resolve();
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new IncompleteChildProcessShutdownError(child.pid));
  }
  if (child.pid === undefined) {
    return Promise.reject(new IncompleteChildProcessShutdownError(undefined));
  }

  const pid = child.pid;
  let beginShutdown!: () => void;
  const shutdown = new Promise<void>((resolve, reject) => {
    beginShutdown = () => {
      let rootClosed = false;
      let treeTerminationConfirmed = false;
      let settled = false;
      const timeout = setTimeout(() => {
        settle(new IncompleteChildProcessShutdownError(pid));
      }, options.timeoutMs ?? 3_000);
      timeout.unref?.();

      const handleClose = () => {
        rootClosed = true;
        settleIfComplete();
      };
      child.once("close", handleClose);

      try {
        const killTree =
          options.killTree ??
          ((processId: number) => {
            execFileSync("taskkill", ["/T", "/F", "/PID", String(processId)], {
              stdio: "ignore",
              timeout: options.timeoutMs ?? 3_000,
            });
          });
        killTree(pid);
        treeTerminationConfirmed = true;
      } catch {
        settle(new IncompleteChildProcessShutdownError(pid));
        return;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        rootClosed = true;
      }
      settleIfComplete();

      function settleIfComplete(): void {
        if (treeTerminationConfirmed && rootClosed) {
          settle(
            options.ownershipLost
              ? new IncompleteChildProcessShutdownError(pid)
              : undefined,
          );
        }
      }

      function settle(error?: Error): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.off("close", handleClose);
        if (error === undefined) {
          closedWindowsProcessTrees.add(child);
          resolve();
        } else {
          reject(error);
        }
      }
    };
  });
  activeWindowsTreeShutdowns.set(child, shutdown);
  beginShutdown();
  void shutdown.then(clearActiveShutdown, clearActiveShutdown);
  return shutdown;

  function clearActiveShutdown(): void {
    if (activeWindowsTreeShutdowns.get(child) === shutdown) {
      activeWindowsTreeShutdowns.delete(child);
    }
  }
}

export function shutdownChildProcess(
  child: ChildProcess,
  options: ShutdownChildProcessOptions,
): Promise<void> {
  const activeShutdown = activeShutdowns.get(child);
  if (activeShutdown) {
    return activeShutdown;
  }

  const ownedProcessGroupId = options.detached && child.pid ? -child.pid : null;
  let ownsProcessGroup =
    ownedProcessGroupId !== null &&
    child.exitCode === null &&
    child.signalCode === null &&
    !closedOwnedProcessGroupLeaders.has(child);
  if (
    ownedProcessGroupId === null &&
    (child.exitCode != null || child.signalCode != null)
  ) {
    return Promise.resolve();
  }

  const shutdown = performShutdown();
  activeShutdowns.set(child, shutdown);
  void shutdown.then(clearActiveShutdown, clearActiveShutdown);
  return shutdown;

  function clearActiveShutdown(): void {
    if (activeShutdowns.get(child) === shutdown) {
      activeShutdowns.delete(child);
    }
  }

  function performShutdown(): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 3_000;
    return new Promise<void>((resolve, reject) => {
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let hardDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        if (hardDeadlineTimer) {
          clearTimeout(hardDeadlineTimer);
          hardDeadlineTimer = null;
        }
        child.off("close", handleClose);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      const handleClose = () => {
        ownsProcessGroup = false;
        if (ownedProcessGroupId === null) {
          settle();
          return;
        }
        if (!isProcessGroupPresent()) {
          settle();
          return;
        }
        waitForPassiveGroupExit();
      };

      const waitForPassiveGroupExit = () => {
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        if (hardDeadlineTimer !== null) {
          return;
        }
        hardDeadlineTimer = setTimeout(() => {
          if (!isProcessGroupPresent()) {
            settle();
            return;
          }
          settle(new IncompleteChildProcessShutdownError(child.pid));
        }, SHUTDOWN_CONFIRMATION_GRACE_MS);
      };

      child.on("close", handleClose);

      if (ownedProcessGroupId !== null && !ownsProcessGroup) {
        if (!isProcessGroupPresent()) {
          settle();
        } else {
          waitForPassiveGroupExit();
        }
        return;
      }

      try {
        signalShutdownTarget("SIGTERM");
      } catch {
        // Best-effort cleanup only.
      }

      forceKillTimer = setTimeout(() => {
        if (ownedProcessGroupId !== null && !ownsProcessGroup) {
          if (!isProcessGroupPresent()) {
            settle();
          } else {
            settle(new IncompleteChildProcessShutdownError(child.pid));
          }
          return;
        }

        try {
          signalShutdownTarget("SIGKILL", ownedProcessGroupId === null);
        } catch {
          // Best-effort cleanup only.
        }

        hardDeadlineTimer = setTimeout(() => {
          if (ownedProcessGroupId !== null && !isProcessGroupPresent()) {
            settle();
            return;
          }
          settle(new IncompleteChildProcessShutdownError(child.pid));
        }, SHUTDOWN_CONFIRMATION_GRACE_MS);
        if (ownedProcessGroupId === null) {
          hardDeadlineTimer.unref?.();
        }
      }, timeoutMs);
      if (ownedProcessGroupId === null) {
        forceKillTimer.unref?.();
      }
    });
  }

  function isProcessGroupPresent(): boolean {
    if (ownedProcessGroupId === null) {
      return false;
    }

    const killProcess = options.killProcess ?? process.kill.bind(process);
    try {
      killProcess(ownedProcessGroupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  function signalShutdownTarget(
    signal: NodeJS.Signals,
    allowDirectChildFallback = true,
  ): boolean {
    if (ownedProcessGroupId !== null) {
      const killProcess = options.killProcess ?? process.kill.bind(process);
      try {
        killProcess(ownedProcessGroupId, signal);
        return true;
      } catch {
        ownsProcessGroup = false;
        if (!allowDirectChildFallback) {
          return false;
        }
      }
    }

    child.kill(signal);
    return false;
  }
}
