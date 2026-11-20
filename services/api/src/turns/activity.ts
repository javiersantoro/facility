/**
 * Readable projection of a stored turn event. The raw event stays available on
 * its own endpoint; this projection is what conversation and timeline surfaces
 * page through, so every item is bounded regardless of the stored payload size.
 *
 * Only activity the engine exposes legitimately is described here: progress
 * messages, tool and command use, reasoning summaries, results and lifecycle
 * events. Nothing is inferred or reconstructed from missing data.
 */

export const ACTIVITY_TEXT_LIMIT = 2_000;

/** Stored event types that carry no standalone information for readers. */
export const ACTIVITY_NOISE_TYPES = [
  "engine.item.updated",
  "engine.stream_event",
  "engine.text",
  "turn.environment_progress",
] as const;

/** Health/credential maintenance remains inspectable but is not evidence of work advancing. */
export const PROGRESS_NOISE_TYPES = [
  ...ACTIVITY_NOISE_TYPES,
  "workspace.health",
  "github.credentials.renewed",
] as const;

export type ActivityKind =
  | "message"
  | "reasoning"
  | "tool"
  | "command"
  | "file_change"
  | "result"
  | "lifecycle"
  | "error"
  | "session"
  | "other";

export type ActivityItem = {
  seq: number;
  turn_id: string;
  type: string;
  kind: ActivityKind;
  title: string;
  text: string | null;
  truncated: boolean;
  size_bytes: number;
  stream_id?: string;
  transcript_text?: string;
  transcript_excerpt?: boolean;
  created_at: Date;
};

type StoredTurnEvent = {
  turnId: string;
  seq: number;
  type: string;
  data: unknown;
  createdAt: Date;
};

export const RUN_PROGRESS_TYPES = [
  "turn.phase",
  "turn.environment_step",
  "turn.environment_progress",
];

export const AGENT_PROGRESS_TYPES = {
  hermes: [
    "engine.system",
    "engine.text",
    "engine.reply_text",
    "engine.tool_use",
    "engine.tool_result",
  ],
  claude_code: [
    "engine.system",
    "engine.reply_started",
    "engine.reply_text",
    "engine.assistant",
    "engine.user",
  ],
  codex: [
    "engine.turn.started",
    "engine.item.started",
    "engine.item.updated",
    "engine.item.completed",
  ],
};

export function agentProgressTypes(engine: string): string[] {
  return Object.hasOwn(AGENT_PROGRESS_TYPES, engine)
    ? AGENT_PROGRESS_TYPES[engine as keyof typeof AGENT_PROGRESS_TYPES]
    : [];
}

const RUN_PHASES = {
  credentials: {
    title: "Preparing GitHub access",
    detail: "Loading project settings and obtaining repository credentials.",
  },
  workspace: {
    title: "Starting the workspace",
    detail: "Preparing the container and attaching the story’s workspace.",
  },
  environment: {
    title: "Preparing the environment",
    detail: "Getting repositories and project services ready.",
  },
  agent: { title: "Running the agent", detail: "The agent is working in the prepared workspace." },
} as const;

export function presentRunProgress(event: StoredTurnEvent, agentStartedAt?: Date) {
  const data = record(event.data);
  if (event.type.startsWith("engine.")) {
    const { title, detail } = describeAgentProgress(event.type.slice("engine.".length), data);
    return {
      phase: "agent",
      title,
      detail,
      percent: null,
      started_at: (agentStartedAt ?? event.createdAt).toISOString(),
      updated_at: event.createdAt.toISOString(),
    };
  }
  const phase = event.type === "turn.phase" ? text(data.phase) : "environment";
  if (!phase || !Object.hasOwn(RUN_PHASES, phase)) return null;
  const labels = RUN_PHASES[phase as keyof typeof RUN_PHASES];
  const environmentStep = event.type !== "turn.phase";
  const value = data.percent;
  return {
    phase,
    title: (environmentStep && text(data.step)) || labels.title,
    detail: (environmentStep && text(data.detail)) || labels.detail,
    percent:
      environmentStep &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 100
        ? value
        : null,
    started_at: (environmentStep && text(data.startedAt)) || event.createdAt.toISOString(),
    updated_at: event.createdAt.toISOString(),
  };
}

function describeAgentProgress(type: string, data: Record<string, unknown>) {
  const waiting = {
    title: "Waiting for the model",
    detail: "The agent is preparing its request or waiting for model output.",
  };
  const updating = {
    title: "Agent update received",
    detail: "The agent reported activity while working on the run.",
  };
  if (type === "system" || type === "turn.started") return waiting;
  if (type === "text" || type === "reply_started" || type === "reply_text") {
    return { title: "Generating a reply", detail: "The model started streaming reply text." };
  }
  if (type === "tool_use" || type === "tool_result") {
    return {
      title: describeEngineEvent(type, data).title,
      detail:
        type === "tool_use"
          ? "Hermes started a tool in the workspace."
          : "Hermes received the tool result.",
    };
  }
  if (type === "assistant" || type === "user") {
    const blocks = messageBlocks(data);
    const tools = blocks.filter((block) => block.type === "tool_use");
    const results = blocks.filter((block) => block.type === "tool_result");
    if (tools.length) {
      const names = tools.map((tool) => text(tool.name)?.slice(0, 100) ?? "tool");
      return {
        title: `Tool started: ${names.join(", ").slice(0, 180)}`,
        detail: "Claude Code requested a workspace tool.",
      };
    }
    if (results.length) {
      return {
        title: results.some((result) => result.is_error === true) ? "Tool failed" : "Tool finished",
        detail: "Claude Code received the tool result.",
      };
    }
    if (type === "assistant" && blocks.some((block) => block.type === "text" && text(block.text))) {
      return {
        title: "Agent message received",
        detail: "Claude Code sent a message. It appears in the activity log.",
      };
    }
    return updating;
  }
  const item = record(data.item);
  if (item.type === "agent_message") {
    return type === "item.completed"
      ? {
          title: "Agent message received",
          detail: "Codex sent a message. It appears in the activity log.",
        }
      : { title: "Generating a reply", detail: "Codex reported an in-progress message." };
  }
  if (item.type === "reasoning") {
    return { title: "Model progress reported", detail: "Codex reported a reasoning update." };
  }
  if (item.type === "mcp_tool_call" && type === "item.completed" && item.status === "failed") {
    return { title: "Tool failed", detail: "Codex reported an unsuccessful tool call." };
  }
  if (item.type) {
    return {
      title: describeCodexItem(type !== "item.completed", item).title.slice(0, 180),
      detail:
        type === "item.completed"
          ? "Codex completed this activity."
          : "Codex reported ongoing activity.",
    };
  }
  return updating;
}

function messageBlocks(data: Record<string, unknown>) {
  const content = record(data.message).content;
  return Array.isArray(content) ? content.map(record) : [];
}

export function presentTurnEvent(event: StoredTurnEvent): ActivityItem {
  const data = record(event.data);
  const sizeBytes = Buffer.byteLength(JSON.stringify(event.data ?? {}), "utf8");
  const described = describe(event.type, data);
  const bounded = bound(described.text);
  const transcriptText =
    (described.kind === "message" ||
      described.kind === "reasoning" ||
      described.kind === "result") &&
    bounded.truncated
      ? described.text?.slice(0, 64_000)
      : undefined;
  const streamId = text(data.stream_id)?.slice(0, 100);
  return {
    seq: event.seq,
    turn_id: event.turnId,
    type: event.type,
    kind: described.kind,
    title: described.title,
    text: bounded.text,
    truncated: bounded.truncated || data.truncated === true,
    size_bytes: sizeBytes,
    created_at: event.createdAt,
    ...(streamId === undefined ? {} : { stream_id: streamId }),
    ...(transcriptText === undefined ? {} : { transcript_text: transcriptText }),
    ...(data.excerpt === true ||
    (transcriptText !== undefined && transcriptText.length < (described.text?.length ?? 0))
      ? { transcript_excerpt: true }
      : {}),
  };
}

function describe(
  type: string,
  data: Record<string, unknown>,
): {
  kind: ActivityKind;
  title: string;
  text: string | null;
} {
  if (data.truncated === true && typeof data.payload === "string") {
    return {
      kind: "other",
      title: `${humanType(type)} (stored truncated)`,
      text: data.payload,
    };
  }
  switch (type) {
    case "turn.workflow_held":
      return { kind: "lifecycle", title: "Workflow held this run", text: text(data.reason) };
    case "turn.deferred":
      return {
        kind: "lifecycle",
        title: "Run deferred",
        text:
          [text(data.reason), text(data.retryAfter) ? `Retry after ${text(data.retryAfter)}` : null]
            .filter(Boolean)
            .join(" · ") || null,
      };
    case "turn.phase":
      return { kind: "lifecycle", title: "Run phase", text: text(data.phase) };
    case "turn.environment_step":
      return {
        kind: "lifecycle",
        title: text(data.step) ?? "Preparing the environment",
        text: text(data.detail),
      };
    case "workspace.health":
      return {
        kind: data.probe === "unavailable" ? "error" : "lifecycle",
        title:
          data.probe === "unavailable"
            ? "Workspace health probe unavailable"
            : "Workspace health recorded",
        text: JSON.stringify(data),
      };
    case "turn.started":
      return { kind: "lifecycle", title: "Run started", text: null };
    case "github.credentials.renewed":
      return { kind: "lifecycle", title: "GitHub credentials renewed", text: null };
    case "github.credentials.retrying":
      return {
        kind: "error",
        title: "Retrying GitHub credential renewal",
        text: "Local work is retained. Publishing requires a current credential.",
      };
    case "github.credentials.revoked":
      return {
        kind: "error",
        title: "GitHub execution access revoked",
        text: "Execution stopped; local work is retained.",
      };
    case "github.credentials.cleanup_failed":
      return {
        kind: "error",
        title: "Temporary credential cleanup could not be confirmed",
        text: "Credentials retain their original expiry.",
      };
    case "turn.succeeded":
      return {
        kind: "lifecycle",
        title: "Run completed",
        text: typeof data.durationMs === "number" ? `Duration ${duration(data.durationMs)}` : null,
      };
    case "turn.failed":
      return { kind: "error", title: "Run failed", text: text(data.error) };
    case "turn.canceled":
      return { kind: "lifecycle", title: "Run canceled", text: null };
    case "turn.cancel_requested":
      return { kind: "lifecycle", title: "Cancellation requested", text: text(data.reason) };
    case "turn.worker_interrupted":
      return {
        kind: "error",
        title: "Worker interrupted",
        text: text(data.reason) ?? text(data.error),
      };
    case "queue.activation_failed":
      return {
        kind: "error",
        title: `Could not start the queued ${text(data.agentName) ?? "agent"} run`,
        text: text(data.error),
      };
    case "engine.session_corrupt":
      return {
        kind: "session",
        title: "Native session could not be resumed",
        text: text(data.sessionId) ? `Session ${text(data.sessionId)}` : null,
      };
    default:
      break;
  }
  if (type.startsWith("engine.")) return describeEngineEvent(type.slice("engine.".length), data);
  return { kind: "other", title: humanType(type), text: null };
}

function describeEngineEvent(
  type: string,
  data: Record<string, unknown>,
): { kind: ActivityKind; title: string; text: string | null } {
  if (type === "observation") {
    const recovered = data.state === "recovered";
    const failed = data.state === "failed";
    return {
      kind: failed ? "error" : "lifecycle",
      title: recovered
        ? "Command observation recovered"
        : failed
          ? "Command observation failed"
          : "Recovering command observation",
      text: `Operation: ${text(data.operation) ?? "unknown"}. ${recovered ? "Output collection resumed." : failed ? "The provider read could not continue." : "Reconnecting to the existing command; it has not been resubmitted."}`,
    };
  }
  if (type === "tool_use" || type === "tool_result") {
    const name = text(data.name)?.slice(0, 100);
    const tool = name ? name.replaceAll("_", " ") : "tool";
    const failed = type === "tool_result" && data.is_error === true;
    const elapsed = typeof data.duration_ms === "number" ? duration(data.duration_ms) : null;
    return {
      kind: failed ? "error" : "tool",
      title:
        type === "tool_use"
          ? `Tool started: ${tool}`
          : failed
            ? `Tool failed: ${tool}`
            : `Tool finished: ${tool}`,
      text: type === "tool_result" && elapsed ? `Duration ${elapsed}` : null,
    };
  }
  // Claude Code stream-json
  if (type === "reply_text")
    return {
      kind: "message",
      title: data.complete === true ? "Agent reply" : "Reply streaming",
      text: text(data.text),
    };
  if (type === "reply_started")
    return { kind: "lifecycle", title: "Reply started streaming", text: null };
  if (type === "system") {
    const model = text(data.model);
    return {
      kind: "session",
      title: text(data.subtype) === "init" ? "Session started" : "Engine notice",
      text: model ? `Model ${model}` : null,
    };
  }
  if (type === "assistant") {
    const blocks = messageBlocks(data);
    const tools = blocks.filter((block) => block.type === "tool_use");
    const texts = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text));
    if (tools.length > 0) {
      const names = tools.map((tool) => text(tool.name) ?? "tool");
      const input = tools.length === 1 ? summarizeToolInput(record(tools[0]?.input)) : null;
      return {
        kind: "tool",
        title: names.length === 1 ? `Used ${names[0]}` : `Used ${names.join(", ")}`,
        text: [texts.join("\n\n"), input].filter(Boolean).join("\n\n") || null,
      };
    }
    return { kind: "message", title: "Agent message", text: texts.join("\n\n") || null };
  }
  if (type === "user") {
    const blocks = messageBlocks(data);
    const results = blocks.filter((block) => block.type === "tool_result");
    if (results.length === 0) return { kind: "other", title: "Engine input", text: null };
    const errored = results.some((result) => result.is_error === true);
    return {
      kind: errored ? "error" : "tool",
      title: errored ? "Tool reported an error" : "Tool result",
      text:
        results
          .map((result) => contentText(result.content))
          .filter(Boolean)
          .join("\n\n") || null,
    };
  }
  if (type === "result") {
    // Hermes reports its diagnostic in the structured result, including for older stored runs.
    if (typeof data.exit_code === "number") {
      const failed = data.exit_code !== 0;
      return {
        kind: failed ? "error" : "result",
        title: failed ? "Hermes reported an error" : "Final response",
        text: failed ? (text(data.error) ?? text(data.text)) : text(data.text),
      };
    }
    const isError = data.is_error === true;
    const subtype = text(data.subtype);
    return {
      kind: isError ? "error" : "result",
      title: isError
        ? `Engine finished with an error${subtype ? ` (${subtype})` : ""}`
        : "Final response",
      text: text(data.result),
    };
  }
  // Codex JSONL
  if (type === "thread.started") {
    return {
      kind: "session",
      title: "Session started",
      text: text(data.thread_id) ? `Thread ${text(data.thread_id)}` : null,
    };
  }
  if (type === "turn.started")
    return { kind: "lifecycle", title: "Engine turn started", text: null };
  if (type === "turn.completed")
    return { kind: "lifecycle", title: "Engine turn completed", text: null };
  if (type === "turn.failed" || type === "error") {
    const error = record(data.error);
    return {
      kind: "error",
      title: "Engine reported an error",
      text: text(error.message) ?? text(data.message),
    };
  }
  if (type === "item.started" || type === "item.completed") {
    return describeCodexItem(type === "item.started", record(data.item));
  }
  return { kind: "other", title: humanType(type), text: null };
}

function describeCodexItem(
  started: boolean,
  item: Record<string, unknown>,
): { kind: ActivityKind; title: string; text: string | null } {
  const itemType = text(item.type) ?? "item";
  switch (itemType) {
    case "agent_message":
      return { kind: "message", title: "Agent message", text: text(item.text) };
    case "reasoning":
      return { kind: "reasoning", title: "Reasoning summary", text: text(item.text) };
    case "command_execution": {
      const command = text(item.command) ?? "command";
      if (started) return { kind: "command", title: "Running command", text: command };
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const status = text(item.status);
      const outcome =
        exitCode === null ? (status ?? "finished") : exitCode === 0 ? "exit 0" : `exit ${exitCode}`;
      return {
        kind: exitCode !== null && exitCode !== 0 ? "error" : "command",
        title: `Command ${outcome}`,
        text: [command, text(item.aggregated_output)].filter(Boolean).join("\n\n") || null,
      };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
      const lines = changes
        .map((change) => `${text(change.kind) ?? "changed"} ${text(change.path) ?? ""}`.trim())
        .filter(Boolean);
      return {
        kind: "file_change",
        title: started
          ? "Changing files"
          : `Changed ${changes.length} file${changes.length === 1 ? "" : "s"}`,
        text: lines.join("\n") || null,
      };
    }
    case "mcp_tool_call": {
      const name = [text(item.server), text(item.tool)].filter(Boolean).join(" · ") || "tool";
      return {
        kind: "tool",
        title: started ? `Calling ${name}` : `Called ${name}`,
        text: text(item.status) ? `Status ${text(item.status)}` : null,
      };
    }
    case "web_search":
      return { kind: "tool", title: "Web search", text: text(item.query) };
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items.map(record) : [];
      return {
        kind: "other",
        title: "Plan updated",
        text:
          items
            .map((entry) => `${entry.completed === true ? "[x]" : "[ ]"} ${text(entry.text) ?? ""}`)
            .join("\n") || null,
      };
    }
    case "error":
      return { kind: "error", title: "Engine reported an error", text: text(item.message) };
    default:
      return {
        kind: "other",
        title: `${started ? "Started" : "Completed"} ${itemType.replaceAll("_", " ")}`,
        text: null,
      };
  }
}

function summarizeToolInput(input: Record<string, unknown>) {
  const preferred = ["command", "file_path", "path", "pattern", "query", "url", "description"];
  for (const key of preferred) {
    const value = text(input[key]);
    if (value) return value;
  }
  const keys = Object.keys(input);
  return keys.length > 0 ? JSON.stringify(input) : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(record)
      .map((block) => (block.type === "text" ? text(block.text) : null))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function bound(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  if (value.length <= ACTIVITY_TEXT_LIMIT) return { text: value, truncated: false };
  return { text: `${value.slice(0, ACTIVITY_TEXT_LIMIT)}…`, truncated: true };
}

function humanType(type: string) {
  return type.replaceAll(".", " ").replaceAll("_", " ");
}

function duration(ms: number) {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
