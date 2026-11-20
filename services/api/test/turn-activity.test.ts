import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_LIMIT,
  presentRunProgress,
  presentTurnEvent,
} from "../src/turns/activity.js";
import {
  ClaudeEventParser,
  CodexEventParser,
  separateFinalResponse,
} from "../src/turns/engines.js";

import { redactEngineActivity } from "../src/turns/redaction.js";
import { gitProgressReader } from "../src/workspaces/project-environment.js";

const at = new Date("2026-09-10T10:00:00Z");

function event(type: string, data: Record<string, unknown>, seq = 1) {
  return { turnId: "turn_a", seq, type, data, createdAt: at };
}

it.each([
  ["recovering", "Recovering command observation"],
  ["recovered", "Command observation recovered"],
  ["failed", "Command observation failed"],
])("presents observation state %s independently from agent output", (state, title) => {
  const activity = presentTurnEvent(
    event("engine.observation", { state, operation: "journal", attempt: 1, elapsedMs: 30_000 }),
  );
  expect(activity.title).toBe(title);
  expect(activity.text).toContain("journal");
  expect(activity.kind).toBe(state === "failed" ? "error" : "lifecycle");
});

it("reads Git progress split across chunks without retaining arbitrary stderr", () => {
  const read = gitProgressReader();
  expect(read("remote: Receiving objects: 90% private\rReceiv")).toBeUndefined();
  expect(read("ing objects:  42% (42/100), 3.1 MiB | 1 MiB/s\r")).toEqual({
    detail: "Receiving objects",
    percent: 42,
  });
  expect(read("warning: transport token private\nResolving deltas: 101%\r")).toBeUndefined();
  expect(read("Resolving deltas:  0%\rResolving deltas:  8%\r")).toEqual({
    detail: "Resolving deltas",
    percent: 8,
  });
});

it("projects real progress and preserves an older run's phase", () => {
  const step = {
    step: "Cloning app",
    detail: "Receiving objects",
    percent: 42,
    startedAt: at.toISOString(),
  };
  expect(presentRunProgress(event("turn.environment_progress", step))).toEqual({
    phase: "environment",
    title: "Cloning app",
    detail: "Receiving objects",
    percent: 42,
    started_at: at.toISOString(),
    updated_at: at.toISOString(),
  });
  expect(presentRunProgress(event("turn.phase", { phase: "environment" }))).toMatchObject({
    title: "Preparing the environment",
    percent: null,
  });
  expect(presentRunProgress(event("turn.phase", { phase: "unknown" }))).toBeNull();
});

it("presents live Hermes status without copying tool arguments or answer chunks", () => {
  const started = new Date(at.getTime() - 5_000);
  expect(presentRunProgress(event("engine.system", { subtype: "init" }), started)).toMatchObject({
    phase: "agent",
    title: "Waiting for the model",
    percent: null,
    started_at: started.toISOString(),
  });
  expect(
    presentRunProgress(
      event("engine.tool_use", { name: "read_file", input: { path: "private.txt" } }),
    ),
  ).toMatchObject({ title: "Tool started: read file" });
  expect(
    presentTurnEvent(
      event("engine.tool_result", {
        name: "read_file",
        is_error: true,
        output: "private file data",
        duration_ms: 200,
      }),
    ),
  ).toMatchObject({ kind: "error", title: "Tool failed: read file", text: "Duration 200 ms" });
  const generating = presentRunProgress(
    event("engine.text", { text: "private text fragment" }),
    started,
  );
  expect(generating).toMatchObject({
    title: "Generating a reply",
    percent: null,
    started_at: started.toISOString(),
  });
  expect(JSON.stringify(generating)).not.toContain("private text fragment");
});

it.each([
  ["engine.reply_started", {}, "Generating a reply"],
  [
    "engine.assistant",
    { message: { content: [{ type: "tool_use", name: "Read" }] } },
    "Tool started: Read",
  ],
  [
    "engine.user",
    { message: { content: [{ type: "tool_result", is_error: true }] } },
    "Tool failed",
  ],
  ["engine.turn.started", {}, "Waiting for the model"],
  [
    "engine.item.started",
    { item: { type: "command_execution", command: "echo private" } },
    "Running command",
  ],
  [
    "engine.item.completed",
    { item: { type: "command_execution", exit_code: 1 } },
    "Command exit 1",
  ],
  [
    "engine.item.updated",
    { item: { type: "agent_message", text: "private" } },
    "Generating a reply",
  ],
  [
    "engine.item.completed",
    { item: { type: "reasoning", text: "private" } },
    "Model progress reported",
  ],
] as const)("projects live agent update %s", (type, data, title) => {
  const progress = presentRunProgress(event(type, data));
  expect(progress).toMatchObject({ phase: "agent", title, percent: null });
  expect(JSON.stringify(progress)).not.toContain("private");
});

it("redacts credentials split across reply snapshots before projecting transcript text", () => {
  const secret = "key-sensitive-value";
  const type = "reply_text";
  const draft = redactEngineActivity(
    {
      type,
      data: {
        stream_id: "reply",
        complete: false,
        text: "Reviewing the file. key-sensitive",
      },
    },
    [secret],
  );
  expect(draft.text).toBe("Reviewing the file. ");
  const finished = redactEngineActivity(
    {
      type,
      data: {
        stream_id: "reply",
        complete: true,
        text: "Reviewing the file. key-sensitive-value",
      },
    },
    [secret],
  );
  const display = presentTurnEvent(event("engine.reply_text", finished));
  expect(display).toMatchObject({
    kind: "message",
    stream_id: "reply",
    text: "Reviewing the file. [REDACTED]",
  });
  expect(JSON.stringify(display)).not.toContain(secret);
});

describe("engine final response separation", () => {
  it("keeps only the last Codex agent message as the final response", () => {
    const parser = new CodexEventParser();
    parser.push(
      `${[
        JSON.stringify({ type: "thread.started", thread_id: "thread" }),
        JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Plan" } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I'll start by reading the tests." },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
        }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "   " } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done: the fix is in place and tests pass." },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join("\n")}\n`,
    );
    parser.finish();
    const result = parser.result();
    expect(result.output).toBe("Done: the fix is in place and tests pass.");
    expect(result.progress).toEqual(["I'll start by reading the tests."]);
    expect(result.model).toBeUndefined();
  });

  it("uses the Claude result as the final response and reports the model", () => {
    const parser = new ClaudeEventParser();
    parser.push(
      `${[
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session",
          model: "claude-opus-4-8",
        }),
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-opus-4-8", content: [{ type: "text", text: "Looking" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "All good." }] },
        }),
        JSON.stringify({ type: "result", session_id: "session", result: "All good." }),
      ].join("\n")}\n`,
    );
    parser.finish();
    const result = parser.result();
    expect(result.output).toBe("All good.");
    expect(result.progress).toEqual(["Looking"]);
    expect(result.model).toBe("claude-opus-4-8");
  });

  it("falls back to the last assistant text when Claude emits no result", () => {
    const parser = new ClaudeEventParser();
    parser.push(
      `${[
        JSON.stringify({ type: "system", subtype: "init", session_id: "session" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "One" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Two" }] },
        }),
      ].join("\n")}\n`,
    );
    parser.finish();
    expect(parser.result()).toMatchObject({ output: "Two", progress: ["One"] });
  });

  it("separates an explicit final response without counting its trailing duplicate", () => {
    expect(separateFinalResponse(["a", "b"], "b")).toEqual({ output: "b", progress: ["a"] });
    expect(separateFinalResponse(["a", "b"], "c")).toEqual({ output: "c", progress: ["a", "b"] });
    expect(separateFinalResponse([])).toEqual({ output: "", progress: [] });
    expect(separateFinalResponse(["only"])).toEqual({ output: "only", progress: [] });
  });
});

describe("turn activity presentation", () => {
  it("describes Codex items by kind", () => {
    expect(
      presentTurnEvent(
        event("engine.item.completed", {
          item: {
            type: "command_execution",
            command: "pnpm test",
            exit_code: 1,
            aggregated_output: "1 failed",
          },
        }),
      ),
    ).toMatchObject({ kind: "error", title: "Command exit 1", text: "pnpm test\n\n1 failed" });
    expect(
      presentTurnEvent(
        event("engine.item.started", { item: { type: "command_execution", command: "ls" } }),
      ),
    ).toMatchObject({ kind: "command", title: "Running command", text: "ls" });
    expect(
      presentTurnEvent(
        event("engine.item.completed", {
          item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }] },
        }),
      ),
    ).toMatchObject({ kind: "file_change", title: "Changed 1 file", text: "update src/a.ts" });
    expect(
      presentTurnEvent(
        event("engine.item.completed", { item: { type: "reasoning", text: "Think" } }),
      ),
    ).toMatchObject({ kind: "reasoning", title: "Reasoning summary", text: "Think" });
    expect(
      presentTurnEvent(
        event("engine.item.completed", { item: { type: "agent_message", text: "Hi" } }),
      ),
    ).toMatchObject({ kind: "message", title: "Agent message", text: "Hi" });
    expect(
      presentTurnEvent(event("engine.turn.failed", { error: { message: "quota" } })),
    ).toMatchObject({ kind: "error", text: "quota" });
  });

  it("shows the saved Hermes diagnostic in run activity", () => {
    const error = "Model context has 48,128 tokens. Hermes requires at least 64,000.";
    expect(
      presentTurnEvent(
        event("engine.result", {
          exit_code: 1,
          session_id: "local-session",
          text: "Something went wrong",
          error,
        }),
      ),
    ).toMatchObject({ kind: "error", title: "Hermes reported an error", text: error });
  });

  it("describes Claude blocks, tool results, and the final result", () => {
    expect(
      presentTurnEvent(
        event("engine.assistant", {
          message: {
            content: [
              { type: "text", text: "Reading" },
              { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            ],
          },
        }),
      ),
    ).toMatchObject({ kind: "tool", title: "Used Read", text: "Reading\n\nsrc/a.ts" });
    expect(
      presentTurnEvent(
        event("engine.user", {
          message: { content: [{ type: "tool_result", is_error: true, content: "ENOENT" }] },
        }),
      ),
    ).toMatchObject({ kind: "error", title: "Tool reported an error", text: "ENOENT" });
    expect(
      presentTurnEvent(event("engine.result", { subtype: "success", result: "Shipped." })),
    ).toMatchObject({ kind: "result", title: "Final response", text: "Shipped." });
    expect(
      presentTurnEvent(event("engine.result", { subtype: "error_max_turns", is_error: true })),
    ).toMatchObject({ kind: "error", title: "Engine finished with an error (error_max_turns)" });
    expect(
      presentTurnEvent(event("engine.system", { subtype: "init", model: "claude-opus-4-8" })),
    ).toMatchObject({ kind: "session", text: "Model claude-opus-4-8" });
  });

  it("describes Facility lifecycle events", () => {
    expect(
      presentTurnEvent(event("turn.workflow_held", { reason: "Approval required" })),
    ).toMatchObject({
      kind: "lifecycle",
      title: "Workflow held this run",
      text: "Approval required",
    });
    expect(
      presentTurnEvent(
        event("turn.deferred", { reason: "github_rate_limit", retryAfter: "2026-11-05T10:00:00Z" }),
      ),
    ).toMatchObject({
      kind: "lifecycle",
      title: "Run deferred",
      text: "github_rate_limit · Retry after 2026-11-05T10:00:00Z",
    });
    expect(presentTurnEvent(event("turn.started", {}))).toMatchObject({
      kind: "lifecycle",
      title: "Run started",
      text: null,
    });
    expect(presentTurnEvent(event("turn.failed", { error: "boom" }))).toMatchObject({
      kind: "error",
      title: "Run failed",
      text: "boom",
    });
    expect(presentTurnEvent(event("turn.succeeded", { durationMs: 65_000 }))).toMatchObject({
      kind: "lifecycle",
      text: "Duration 1 min 5 s",
    });
    expect(presentTurnEvent(event("some.unknown_type", {}))).toMatchObject({
      kind: "other",
      title: "some unknown type",
    });
  });

  it("bounds long text and reports the stored size", () => {
    const long = "x".repeat(ACTIVITY_TEXT_LIMIT + 500);
    const item = presentTurnEvent(
      event("engine.item.completed", { item: { type: "agent_message", text: long } }),
    );
    expect(item.truncated).toBe(true);
    expect(item.text?.length).toBe(ACTIVITY_TEXT_LIMIT + 1);
    expect(item.size_bytes).toBeGreaterThan(ACTIVITY_TEXT_LIMIT);
    const stored = presentTurnEvent(event("engine.assistant", { truncated: true, payload: "{…" }));
    expect(stored).toMatchObject({ truncated: true, title: "engine assistant (stored truncated)" });
  });
});
