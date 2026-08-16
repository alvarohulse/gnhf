import type { ChildProcess } from "node:child_process";

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

const POST_SIGKILL_GRACE_MS = 100;
const activeShutdowns = new WeakMap<ChildProcess, Promise<void>>();

export class ChildProcessShutdownTracker {
  private pending = new Set<Promise<void>>();

  start(startShutdown: () => Promise<void>): Promise<void> {
    const shutdown = startShutdown();
    this.pending.add(shutdown);
    void shutdown.then(
      () => this.pending.delete(shutdown),
      () => this.pending.delete(shutdown),
    );
    return shutdown;
  }

  async waitForAll(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  async finalizeOwnedProcessGroup(
    child: ChildProcess,
    detached: boolean,
    startShutdown: () => Promise<void>,
  ): Promise<void> {
    if (!detached || child.pid === undefined) {
      return;
    }
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

  if (options.detached && child.pid) {
    try {
      killProcess(-child.pid, options.signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }

  child.kill(options.signal);
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
  if (
    ownedProcessGroupId === null &&
    (child.exitCode != null || child.signalCode != null)
  ) {
    return Promise.resolve();
  }

  const shutdown = performShutdown();
  activeShutdowns.set(child, shutdown);
  void shutdown.finally(() => {
    if (activeShutdowns.get(child) === shutdown) {
      activeShutdowns.delete(child);
    }
  });
  return shutdown;

  function performShutdown(): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 3_000;
    return new Promise<void>((resolve) => {
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let hardDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const settle = () => {
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
        resolve();
      };

      const handleClose = () => {
        if (ownedProcessGroupId === null) {
          settle();
        }
      };

      child.on("close", handleClose);

      try {
        signalShutdownTarget("SIGTERM");
      } catch {
        // Best-effort cleanup only.
      }

      forceKillTimer = setTimeout(() => {
        try {
          signalShutdownTarget("SIGKILL");
        } catch {
          // Best-effort cleanup only.
        }

        hardDeadlineTimer = setTimeout(() => {
          settle();
        }, POST_SIGKILL_GRACE_MS);
        if (ownedProcessGroupId === null) {
          hardDeadlineTimer.unref?.();
        }
      }, timeoutMs);
      if (ownedProcessGroupId === null) {
        forceKillTimer.unref?.();
      }
    });
  }

  function signalShutdownTarget(signal: NodeJS.Signals): void {
    if (ownedProcessGroupId !== null) {
      const killProcess = options.killProcess ?? process.kill.bind(process);
      try {
        killProcess(ownedProcessGroupId, signal);
        return;
      } catch {
        // Fall back to the exact child below.
      }
    }

    child.kill(signal);
  }
}
