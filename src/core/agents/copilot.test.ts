import { beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { CopilotAgent } from "./copilot.js";
import { buildAgentOutputSchema } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

describe("CopilotAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns copilot in non-interactive JSONL mode with the default permission flag", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({ platform: "win32" });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(mockSpawn).toHaveBeenCalledWith("copilot", args, {
      cwd: "/work/dir",
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("test prompt");
    expect(args[1]).toContain("gnhf final output contract");
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--stream",
        "off",
        "--no-color",
        "--allow-all",
      ]),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      bin: "C:\\tools\\copilot.cmd",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\copilot.cmd",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue(
      "C:\\tools\\copilot-switch.cmd\r\n" as never,
    );
    const agent = new CopilotAgent({
      bin: "copilot-switch",
      platform: "win32",
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "copilot-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("passes configured extra args through and suppresses the default permission flag", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      extraArgs: ["--model", "gpt-5.4", "--allow-all-tools"],
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual([
      "--model",
      "gpt-5.4",
      "--allow-all-tools",
    ]);
    expect(args).not.toContain("--allow-all");
  });

  it("creates an owned process group for unsupervised Unix runs", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      platform: "linux",
      supervisedProcessGroup: false,
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "copilot",
      expect.any(Array),
      expect.objectContaining({ detached: true }),
    );
  });

  it("stays inside an external supervisor process group", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      platform: "linux",
      supervisedProcessGroup: true,
    });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "copilot",
      expect.any(Array),
      expect.objectContaining({ detached: false }),
    );
  });

  it("finishes owned-group shutdown after the leader closes on abort", async () => {
    vi.useFakeTimers();
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 4321 });
    mockSpawn.mockReturnValue(proc);
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);
    const controller = new AbortController();
    const agent = new CopilotAgent({ platform: "linux" });

    try {
      const runPromise = agent.run("test prompt", "/work/dir", {
        signal: controller.signal,
      });
      const rejection = expect(runPromise).rejects.toThrow("Agent was aborted");
      controller.abort();
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");

      proc.emit("close", null);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(processKill).toHaveBeenCalledWith(-4321, "SIGKILL");

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      await agent.close();
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new CopilotAgent({ platform: "win32" });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "6789"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("parses the final assistant message and accumulates output tokens", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();
    const agent = new CopilotAgent();
    const content = JSON.stringify({
      success: true,
      summary: "ok",
      key_changes_made: [],
      key_learnings: [],
    });

    const promise = agent.run("test prompt", "/work/dir", {
      onMessage,
      onUsage,
    });
    emitJson(proc, {
      type: "assistant.message",
      data: { content, outputTokens: 7 },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      output: {
        success: true,
        summary: "ok",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 0,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokensAvailable: false,
      },
    });
    expect(onMessage).toHaveBeenCalledWith(content);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 0,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokensAvailable: false,
    });
  });

  it("marks complete input and output totals available", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();
    const content = JSON.stringify({
      success: true,
      summary: "ok",
      key_changes_made: [],
      key_learnings: [],
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: { content },
    });
    emitJson(proc, {
      type: "result",
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      usage: {
        inputTokens: 5,
        outputTokens: 7,
        tokensAvailable: true,
      },
    });
  });

  it("accepts a fenced JSON final answer", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content:
          '```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("recovers JSON when copilot prepends prose before the final object", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content:
          'Good - all tests pass.\n\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}',
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("recovers fenced JSON when copilot writes prose before the fence", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content:
          'Done.\n\n```json\n{"success":true,"summary":"ok","key_changes_made":[],"key_learnings":[]}\n```',
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: {
        success: true,
        summary: "ok",
      },
    });
  });

  it("includes should_fully_stop in the prompt contract when the schema requires it", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[1]).toContain("should_fully_stop");
  });

  it("rejects when copilot returns no assistant message", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("copilot returned no agent message");
  });

  it("rejects when the final assistant message is not valid JSON", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: { content: "not json" },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse copilot output");
  });

  it("rejects when the final assistant message misses required fields", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: { content: '{"success":true,"summary":"ok"}' },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse copilot output");
  });

  it("rejects commit fields that do not match the schema enum", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new CopilotAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, {
      type: "assistant.message",
      data: {
        content: JSON.stringify({
          success: true,
          summary: "ok",
          key_changes_made: [],
          key_learnings: [],
          commit_type: "chore",
        }),
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Failed to parse copilot output");
  });
});
