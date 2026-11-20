import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentEngineError,
  CLAUDE_READ_ONLY_TOOLS,
  ClaudeCodeEngine,
  ClaudeEventParser,
  CodexEngine,
  CodexEventParser,
  HermesEngine,
  nativeSessionFromEvent,
  observationFailureEvidence,
} from "../src/turns/engines.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type {
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../src/workspaces/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workspace: WorkspaceLocator = {
  id: "ws_0123456789abcdef",
  image: "facility-runner:test",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "volume",
};

function manifest(engine: "claude_code" | "codex" | "hermes") {
  const { name, model } = {
    codex: { name: "builder", model: "gpt-5.5" },
    claude_code: { name: "architect", model: "claude-opus-4-8" },
    hermes: { name: "hermes", model: "qwen3-coder-next" },
  }[engine];
  return parseAgentManifest(
    `---
name: ${name}
description: Test agent.
engine: ${engine}
model: ${model}
enabled: true
options:
  reasoning_effort: high
triggers:
  - type: manual
---
Test prompt.
`,
    `${name}.md`,
  );
}

class EngineRuntime implements WorkspaceRuntime {
  readonly provider = "fake" as const;
  command?: WorkspaceCommand;

  constructor(private readonly result: WorkspaceCommandResult) {}

  async exec(_workspace: WorkspaceLocator, command: WorkspaceCommand) {
    this.command = command;
    for (const chunk of split(this.result.stdout)) {
      command.onOutput?.({ stream: "stdout", data: chunk });
    }
    return this.result;
  }

  create(): never {
    throw new Error("not used");
  }
  wake(): never {
    throw new Error("not used");
  }
  expose(): never {
    throw new Error("not used");
  }
  inspect(): never {
    throw new Error("not used");
  }
  suspend(): never {
    throw new Error("not used");
  }
  retireCompute(): never {
    throw new Error("not used");
  }
  destroy(): never {
    throw new Error("not used");
  }
}

describe("native agent engines", () => {
  const endpoint = "http://host.docker.internal:1234/v1";

  it("runs Hermes and keeps its final reply, usage, and session", async () => {
    const stdout = [
      { type: "system", subtype: "init", session_id: "", model: "qwen3-coder-next" },
      { type: "text", text: "working" },
      {
        type: "result",
        session_id: "20261118_160937_abc123",
        exit_code: 0,
        text: "done",
        tokens: { input: 100, output: 20, cache_read: 3, cache_write: 2 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 12 });
    const events: string[] = [];
    const prompt = '-first line; echo "a"\nsecond line';
    const result = await new HermesEngine(runtime).run({
      turnId: "turn_hermes",
      manifest: manifest("hermes"),
      workspace,
      prompt,
      cwd: "repos/app",
      nativeSessionId: "20261118_160001_def456",
      environment: { HERMES_LM_STUDIO_URL: endpoint, HERMES_LM_STUDIO_TOKEN: "local-token" },
      onEvent: (event) => events.push(event.type),
    });
    expect(runtime.command?.args?.slice(-11)).toEqual([
      "hermes",
      "--resume",
      "20261118_160001_def456",
      "chat",
      "--provider",
      "openai-api",
      "--format",
      "stream-json",
      "--model",
      "qwen3-coder-next",
      `--query=${prompt}`,
    ]);
    expect(runtime.command?.env).toMatchObject({
      HERMES_HOME: "/workspace/.facility/hermes",
      OPENAI_BASE_URL: endpoint,
      OPENAI_API_KEY: "local-token",
      HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: "180",
    });
    expect(result).toMatchObject({
      nativeSessionId: "20261118_160937_abc123",
      output: "done",
      model: "qwen3-coder-next",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2 },
    });
    expect(nativeSessionFromEvent(result.events.at(-1)!)).toBe(result.nativeSessionId);
    expect(events).toEqual(["system", "reply_text", "reply_text", "result"]);
  });

  it.each([
    0, 1,
  ])("reports the Hermes result error instead of its session notice (exit %s)", async (exitCode) => {
    const error = "Model context has 48,128 tokens. Hermes requires at least 64,000.";
    const stdout = JSON.stringify({ type: "result", session_id: "local-123", exit_code: 1, error });
    const runtime = new EngineRuntime({
      exitCode,
      stdout,
      stderr: "Session: local-123",
      durationMs: 12,
    });
    await expect(
      new HermesEngine(runtime).run({
        turnId: "turn_hermes",
        manifest: manifest("hermes"),
        workspace,
        prompt: "work",
        cwd: ".",
        environment: { HERMES_LM_STUDIO_URL: endpoint },
      }),
    ).rejects.toMatchObject({ code: "agent_engine_failed", message: error });
  });

  it("keeps the Hermes process exit code when stderr contains only session notices", async () => {
    const runtime = new EngineRuntime({
      exitCode: 137,
      stdout: '{"type":"system","subtype":"init","session_id":"local-123"}\n',
      stderr: "Session: local-123\n\nsession_id: local-123\n",
      durationMs: 12,
    });
    await expect(
      new HermesEngine(runtime).run({
        turnId: "turn_hermes",
        manifest: manifest("hermes"),
        workspace,
        prompt: "work",
        cwd: ".",
        environment: { HERMES_LM_STUDIO_URL: endpoint },
      }),
    ).rejects.toMatchObject({
      code: "agent_engine_failed",
      message: expect.stringContaining("Hermes exited with status 137."),
      details: { exitCode: 137 },
    });
  });

  it.each([
    [{ readOnly: true }, "agent_read_only_unsupported"],
    [{ maxBudgetUsd: 1 }, "agent_budget_unsupported"],
    [
      { environment: { HERMES_LM_STUDIO_URL: "https://api.openai.com/v1" } },
      "agent_provider_invalid",
    ],
  ] as const)("rejects unsupported Hermes execution before starting a CLI (%#)", async (options, code) => {
    const runtime = new EngineRuntime({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 });
    await expect(
      new HermesEngine(runtime).run({
        turnId: "turn_hermes",
        manifest: manifest("hermes"),
        workspace,
        prompt: "work",
        cwd: ".",
        environment: { HERMES_LM_STUDIO_URL: endpoint },
        ...options,
      }),
    ).rejects.toMatchObject({ code });
    expect(runtime.command).toBeUndefined();
  });

  it.each([
    [{ OPENAI_API_KEY: "project-key" }, "project-key"],
    [{ OPENAI_API_KEY: "project-key", CODEX_API_KEY: "explicit-key" }, "explicit-key"],
    [{ OPENAI_API_KEY: "project-key", CODEX_API_KEY: "" }, ""],
    [{}, undefined],
  ])("passes only the current request's Codex credential without mutating it", async (environment, expected) => {
    const original = { ...environment };
    const runtime = new EngineRuntime({
      exitCode: 0,
      stdout: '{"type":"thread.started","thread_id":"native"}\n',
      stderr: "",
      durationMs: 1,
    });
    await new CodexEngine(runtime).run({
      turnId: "turn_credentials",
      manifest: manifest("codex"),
      workspace,
      prompt: "work",
      cwd: ".",
      environment,
    });
    expect(runtime.command?.env?.CODEX_API_KEY).toBe(expected);
    expect(environment).toEqual(original);
    if (expected) expect(JSON.stringify(runtime.command?.args)).not.toContain(expected);
  });

  it("streams Claude reply snapshots without forwarding thinking deltas", async () => {
    const stream = (event: object) => ({ type: "stream_event", event });
    const stdout =
      [
        { type: "system", subtype: "init", session_id: "claude-session" },
        stream({ type: "message_start" }),
        stream({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "private" },
        }),
        stream({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }),
        stream({ type: "content_block_delta", delta: { type: "text_delta", text: "additional" } }),
        { type: "result", session_id: "claude-session", result: "Final reply" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 12 });
    const events: string[] = [];
    const result = await new ClaudeCodeEngine(runtime).run({
      turnId: "turn_claude",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "Respond",
      cwd: ".",
      onEvent: (event) => events.push(event.type),
    });
    expect(runtime.command?.args).toContain("--include-partial-messages");
    expect(events).toEqual(["system", "reply_text", "reply_text", "result"]);
    expect(result.events[1]?.data).toMatchObject({ text: "partial", complete: false });
    expect(result.events[2]?.data).toMatchObject({ text: "partialadditional", complete: true });
    expect(result.events[1]?.data.stream_id).toBe(result.events[2]?.data.stream_id);
    expect(JSON.stringify(result.events)).not.toContain("private");
    expect(result.output).toBe("Final reply");
  });

  it("parses chunked Claude stream-json and resumes with a budget when supplied", async () => {
    const stdout = `${[
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session",
        result: "done",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 3,
        },
      }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 12 });
    const result = await new ClaudeCodeEngine(runtime).run({
      turnId: "turn_claude",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "claude-session",
      maxBudgetUsd: 0.85,
    });
    expect(result).toMatchObject({
      nativeSessionId: "claude-session",
      output: "done",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        reportedCostCents: 1.23,
      },
    });
    expect(runtime.command).toMatchObject({
      command: "sh",
      cwd: "repos/app",
      env: { FACILITY_TURN_ID: "turn_claude" },
    });
    expect(runtime.command?.args).toContain("claude");
    expect(runtime.command?.args).toContain("--max-budget-usd");
    expect(runtime.command?.args).toContain("0.850000");
    expect(runtime.command?.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "claude-session",
      ]),
    );
  });

  it("parses chunked Codex JSONL and resumes the native thread with no sandbox", async () => {
    const stdout = `${[
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "implemented" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } }),
    ].join("\n")}\n`;
    const runtime = new EngineRuntime({ exitCode: 0, stdout, stderr: "", durationMs: 15 });
    const result = await new CodexEngine(runtime).run({
      turnId: "turn_codex",
      manifest: manifest("codex"),
      workspace,
      prompt: "continue",
      cwd: "repos/app",
      nativeSessionId: "codex-thread",
    });
    expect(result).toMatchObject({
      nativeSessionId: "codex-thread",
      output: "implemented",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    const codexIndex = runtime.command?.args?.indexOf("codex") ?? -1;
    expect(runtime.command?.args?.slice(codexIndex + 1, codexIndex + 4)).toEqual([
      "exec",
      "resume",
      "--json",
    ]);
    expect(runtime.command?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(runtime.command?.args).toEqual(expect.arrayContaining(["codex-thread", "continue"]));
  });

  it("restricts read-only turns to reading tools and Codex's read-only sandbox", async () => {
    const claudeOutput = `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "claude-review",
      result: "reviewed",
    })}\n`;
    const claudeRuntime = new EngineRuntime({
      exitCode: 0,
      stdout: claudeOutput,
      stderr: "",
      durationMs: 5,
    });
    await new ClaudeCodeEngine(claudeRuntime).run({
      turnId: "turn_review",
      manifest: manifest("claude_code"),
      workspace,
      prompt: "review",
      cwd: "repos/app",
      readOnly: true,
    });
    const claudeArgs = claudeRuntime.command?.args ?? [];
    expect(claudeArgs).not.toContain("bypassPermissions");
    expect(claudeArgs).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    const allowed = claudeArgs[claudeArgs.indexOf("--allowedTools") + 1] ?? "";
    expect(allowed.split(",")).toEqual(CLAUDE_READ_ONLY_TOOLS);
    expect(allowed).not.toMatch(/Edit|Write|git push|git commit|git fetch|gh api/);
    // git can write any file through --output even under an allowed read prefix.
    expect(claudeArgs[claudeArgs.indexOf("--disallowedTools") + 1]).toBe(
      "Edit,Write,NotebookEdit,Bash(git * --output*)",
    );
    // Settings, hooks and MCP servers written into the workspace cannot widen the turn.
    expect(claudeArgs[claudeArgs.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(claudeArgs[claudeArgs.indexOf("--settings") + 1] ?? "{}")).toEqual({
      disableAllHooks: true,
    });
    expect(claudeArgs).toContain("--strict-mcp-config");

    const codexOutput = `${JSON.stringify({ type: "thread.started", thread_id: "codex-review" })}\n`;
    const codexRuntime = new EngineRuntime({
      exitCode: 0,
      stdout: codexOutput,
      stderr: "",
      durationMs: 5,
    });
    await new CodexEngine(codexRuntime)
      .run({
        turnId: "turn_review",
        manifest: manifest("codex"),
        workspace,
        prompt: "review",
        cwd: "repos/app",
        readOnly: true,
      })
      .catch(() => undefined);
    const codexArgs = codexRuntime.command?.args ?? [];
    expect(codexArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });

  it("rejects malformed engine output and non-zero exits", async () => {
    const claude = new ClaudeEventParser();
    expect(() => claude.push("not-json\n")).toThrowError(AgentEngineError);

    const codex = new CodexEventParser();
    codex.push(`${JSON.stringify({ type: "thread.started", thread_id: "thread" })}\n`);
    codex.finish();
    expect(codex.result().sessionId).toBe("thread");

    const runtime = new EngineRuntime({
      exitCode: 1,
      stdout: "",
      stderr: "auth failed",
      durationMs: 1,
    });
    await expect(
      new CodexEngine(runtime).run({
        turnId: "turn_failed",
        manifest: manifest("codex"),
        workspace,
        prompt: "work",
        cwd: ".",
      }),
    ).rejects.toMatchObject({ code: "agent_engine_failed", message: "auth failed" });
  });

  it("classifies an invalid native session separately so dispatch can recover", async () => {
    const runtime = new EngineRuntime({
      exitCode: 1,
      stdout: "",
      stderr: "thread not found; cannot resume",
      durationMs: 1,
    });
    await expect(
      new CodexEngine(runtime).run({
        turnId: "turn_corrupt",
        manifest: manifest("codex"),
        workspace,
        prompt: "continue",
        cwd: ".",
        nativeSessionId: "lost-thread",
      }),
    ).rejects.toMatchObject({ code: "agent_session_corrupt" });
  });

  it("runs deterministic native CLI fakes, resumes them, and cancels only their process", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-native-engines-"));
    roots.push(root);
    const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
    const created = await runtime.create({
      id: "ws_1234567890abcdef",
      image: "facility-runner:test",
    });
    await mkdir(join(created.volumeRef, "repo"), { recursive: true });
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" > "$CLAUDE_CONFIG_DIR/last-args"',
        'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"claude-session"}\'',
        'printf \'%s\\n\' \'{"type":"result","session_id":"claude-session","result":"claude complete"}\'',
      ].join("\n"),
    );
    await writeFile(
      join(bin, "codex"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" > "$CODEX_HOME/last-args"',
        "case \"$*\" in *lost-thread*) printf '%s\\n' 'thread lost-thread not found; cannot resume' >&2; exit 7 ;; esac",
        'if test "$FACILITY_FAKE_BLOCK" = 1; then printf started > "$CODEX_HOME/blocking"; sleep 30; fi',
        'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"codex-thread"}\'',
        'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"codex complete"}}\'',
      ].join("\n"),
    );
    await Promise.all([chmod(join(bin, "claude"), 0o755), chmod(join(bin, "codex"), 0o755)]);
    const environment = { PATH: [bin, process.env.PATH].filter(Boolean).join(":") };

    await expect(
      new ClaudeCodeEngine(runtime).run({
        turnId: "turn_native_claude",
        manifest: manifest("claude_code"),
        workspace: created,
        prompt: "plan this story",
        cwd: "repo",
        environment,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "claude-session", output: "claude complete" });
    expect(await runtime.read(created, ".facility/claude/last-args")).toContain(
      "--model claude-opus-4-8",
    );

    const codex = new CodexEngine(runtime);
    await expect(
      codex.run({
        turnId: "turn_native_codex",
        manifest: manifest("codex"),
        workspace: created,
        prompt: "build this story",
        cwd: "repo",
        environment,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "codex-thread", output: "codex complete" });
    expect(await runtime.read(created, ".facility/codex/last-args")).toContain("--model gpt-5.5");
    await expect(
      codex.run({
        turnId: "turn_native_resume",
        manifest: manifest("codex"),
        workspace: created,
        prompt: "continue",
        cwd: "repo",
        nativeSessionId: "codex-thread",
        environment,
      }),
    ).resolves.toMatchObject({ nativeSessionId: "codex-thread" });
    expect(await runtime.read(created, ".facility/codex/last-args")).toContain(
      "exec resume --json",
    );
    await expect(
      codex.run({
        turnId: "turn_native_corrupt",
        manifest: manifest("codex"),
        workspace: created,
        prompt: "continue",
        cwd: "repo",
        nativeSessionId: "lost-thread",
        environment,
      }),
    ).rejects.toMatchObject({ code: "agent_session_corrupt" });

    const controller = new AbortController();
    const blocked = codex.run({
      turnId: "turn_native_cancel",
      manifest: manifest("codex"),
      workspace: created,
      prompt: "wait",
      cwd: "repo",
      environment: { ...environment, FACILITY_FAKE_BLOCK: "1" },
      signal: controller.signal,
    });
    await waitForFile(runtime, created, ".facility/codex/blocking", true);
    controller.abort();
    await expect(blocked).rejects.toMatchObject({ code: "workspace_command_canceled" });
    await waitForFile(runtime, created, ".facility/engine-processes/turn_native_cancel.pid", false);
    await expect(runtime.inspect(created)).resolves.toMatchObject({ state: "running" });
  });
});

function split(value: string) {
  const middle = Math.floor(value.length / 2);
  return [value.slice(0, middle), value.slice(middle)];
}

async function waitForFile(
  runtime: FakeWorkspaceRuntime,
  workspace: WorkspaceLocator,
  path: string,
  present: boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    let found = false;
    try {
      await runtime.read(workspace, path);
      found = true;
    } catch {
      found = false;
    }
    if (found === present) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${path} to be ${present ? "present" : "absent"}`);
}

describe("recovery evidence validation", () => {
  it.each([
    "../../private",
    "secret\nvalue",
    "x".repeat(201),
    {},
    null,
  ])("rejects malformed native session identities", (thread_id) => {
    expect(
      nativeSessionFromEvent({ engine: "codex", type: "thread.started", data: { thread_id } }),
    ).toBeUndefined();
  });
  it("excludes arbitrary provider payloads from structured evidence", () => {
    expect(
      observationFailureEvidence({
        category: "workspace_session_lost",
        httpStatus: 410,
        headers: { authorization: "secret" },
      }),
    ).toEqual({ category: "workspace_session_lost", httpStatus: 410 });
    expect(
      observationFailureEvidence({ category: "private provider message", httpStatus: "secret" }),
    ).toBeUndefined();
  });
});
