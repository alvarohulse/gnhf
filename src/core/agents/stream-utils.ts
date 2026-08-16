import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

/**
 * Wire stderr collection, spawn-error handling, and the common close-handler
 * prefix (logStream.end + non-zero exit code rejection) for a child process.
 * Calls `onSuccess` only when the process exits with code 0.
 */
export function setupChildProcessHandlers(
  child: ChildProcess,
  agentName: string,
  logStream: WriteStream | null,
  reject: (err: Error) => void,
  onSuccess: () => void,
  finalize?: () => Promise<void>,
): void {
  let stderr = "";

  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  const settleAfterFinalize = (settle: () => void) => {
    if (finalize === undefined) {
      settle();
      return;
    }
    void finalize().then(settle, (error: unknown) => {
      reject(
        error instanceof Error
          ? error
          : new Error(`Agent process cleanup failed: ${String(error)}`),
      );
    });
  };

  child.on("error", (err) => {
    settleAfterFinalize(() => {
      reject(new Error(`Failed to spawn ${agentName}: ${err.message}`));
    });
  });

  child.on("close", (code) => {
    logStream?.end();
    settleAfterFinalize(() => {
      if (code !== 0) {
        reject(new Error(`${agentName} exited with code ${code}: ${stderr}`));
        return;
      }
      onSuccess();
    });
  });
}

/**
 * Parse a JSONL stream, calling the callback for each parsed event.
 * Handles buffering of incomplete lines and skips unparseable lines.
 */
export function parseJSONLStream<T>(
  stream: Readable,
  logStream: WriteStream | null,
  callback: (event: T) => void,
): void {
  let buffer = "";
  stream.on("data", (data: Buffer) => {
    logStream?.write(data);
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        callback(JSON.parse(line) as T);
      } catch {
        // Skip unparseable lines
      }
    }
  });
}

/**
 * Wire an AbortSignal to kill a child process.
 * Returns true if the signal was already aborted (caller should return early).
 */
export function setupAbortHandler(
  signal: AbortSignal | undefined,
  child: ChildProcess,
  reject: (err: Error) => void,
  abortChild: () => void | Promise<void> = () => {
    child.kill("SIGTERM");
  },
): boolean {
  if (!signal) return false;

  const onAbort = () => {
    try {
      const shutdown = abortChild();
      if (shutdown !== undefined) {
        const rejectAborted = () => reject(new Error("Agent was aborted"));
        void shutdown.then(rejectAborted, (error: unknown) => {
          reject(
            error instanceof Error
              ? error
              : new Error(`Agent process cleanup failed: ${String(error)}`),
          );
        });
        return;
      }
    } catch {
      reject(new Error("Agent was aborted"));
      return;
    }
    reject(new Error("Agent was aborted"));
  };
  const handleAbort = () => onAbort();
  if (signal.aborted) {
    handleAbort();
    return true;
  }
  signal.addEventListener("abort", handleAbort, { once: true });
  child.on("close", () => signal.removeEventListener("abort", handleAbort));
  return false;
}
