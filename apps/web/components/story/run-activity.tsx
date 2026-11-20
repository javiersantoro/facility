"use client";

import { buttonClassName } from "@facility/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoadMore, type LoadState } from "@/components/story/load-more";
import type { StoryActivityItem, StoryTurnActivityPage, StoryTurnEvent } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { storyActivityPath, storyTurnEventPath } from "@/lib/story-paths";
import { formatTime } from "@/lib/story-presentation";

const transcriptTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const KIND_GLYPH: Record<StoryActivityItem["kind"], string> = {
  message: "💬",
  reasoning: "…",
  tool: "⚙",
  command: "$",
  file_change: "±",
  result: "✓",
  lifecycle: "•",
  error: "!",
  session: "#",
  other: "·",
};
type Props = {
  projectId: string;
  storyId: string;
  turnId: string;
  progressMessages: number | null;
  initiallyOpen?: boolean;
};
function merge(items: StoryActivityItem[], incoming: StoryActivityItem[]) {
  const bySeq = new Map(items.map((item) => [item.seq, item]));
  for (const item of incoming) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

/** Keep an inspected run's history and raw events while new activity is buffered separately. */
export function RunActivity(props: Props) {
  return <RunActivityView key={`${props.projectId}:${props.storyId}:${props.turnId}`} {...props} />;
}
function RunActivityView({
  projectId,
  storyId,
  turnId,
  progressMessages,
  initiallyOpen = false,
}: Props) {
  const [run, setRun] = useState<Pick<StoryTurnActivityPage, "turn" | "progress"> | null>(null);
  const [items, setItems] = useState<StoryActivityItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(initiallyOpen);
  const [pending, setPending] = useState<StoryActivityItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [moreNew, setMoreNew] = useState(false);
  const pendingItems = useRef<StoryActivityItem[]>([]);
  const alive = useRef(true);
  const loaded = useRef(false);
  const olderBusy = useRef(false);
  const newerBusy = useRef(false);
  const highWater = useRef(0);
  const incrementalSupported = useRef(true);
  const openState = useRef(initiallyOpen);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (before?: number) => {
      if (olderBusy.current) return;
      olderBusy.current = true;
      setState("loading");
      setError("");
      const result = await clientApi<StoryTurnActivityPage>(
        "GET",
        storyActivityPath(projectId, storyId, turnId, before),
      );
      olderBusy.current = false;
      if (!alive.current) return;
      if (!result.ok) {
        setState("error");
        setError(result.message);
        return;
      }
      if (result.data?.turn?.id !== turnId || !Array.isArray(result.data.items)) {
        setState("error");
        setError("The requested run's activity was not returned.");
        return;
      }
      if (!loaded.current) {
        highWater.current = result.data.items[0]?.seq ?? 0;
        setRun({ turn: result.data.turn, progress: result.data.progress });
        loaded.current = true;
      }
      setItems((current) => merge(current, result.data.items));
      setCursor(result.data.next_cursor);
      setState(result.data.has_more ? "idle" : "end");
    },
    [projectId, storyId, turnId],
  );

  const checkNew = useCallback(
    async (automatic = false) => {
      if (!loaded.current || newerBusy.current || (automatic && !incrementalSupported.current))
        return;
      newerBusy.current = true;
      setChecking(true);
      setRefreshError("");
      try {
        // Bound each check; a burst continues from the last consumed sequence on the next check.
        for (let page = 0; page < 5; page++) {
          if (page > 0 && (!openState.current || document.visibilityState !== "visible")) break;
          const after = highWater.current;
          const result = await clientApi<StoryTurnActivityPage>(
            "GET",
            storyActivityPath(projectId, storyId, turnId, undefined, after),
          );
          if (!alive.current) return;
          if (!result.ok) {
            setRefreshError(result.message);
            return;
          }
          const data = result.data;
          if (data?.order !== "asc") {
            incrementalSupported.current = false;
            setRefreshError(
              "This server cannot confirm incremental activity. Saved history remains visible; reopen the page to read its latest snapshot.",
            );
            return;
          }
          if (
            !Array.isArray(data.items) ||
            data.turn?.id !== turnId ||
            data.items.some((item) => item.turn_id !== turnId)
          ) {
            setRefreshError("The requested run's incremental activity was not returned.");
            return;
          }
          const seqs = data.items.map((item) => item.seq);
          if (
            data.turn.id !== turnId ||
            seqs.some(
              (seq, index) => !Number.isSafeInteger(seq) || seq <= (seqs[index - 1] ?? after),
            ) ||
            (data.has_more && (seqs.length === 0 || data.next_cursor !== seqs.at(-1)))
          ) {
            setRefreshError(
              "The activity cursor did not advance safely. Saved history remains visible.",
            );
            return;
          }
          incrementalSupported.current = true;
          setRun({ turn: data.turn, progress: data.progress });
          highWater.current = seqs.at(-1) ?? after;
          pendingItems.current = merge(pendingItems.current, data.items);
          setPending(pendingItems.current);
          setMoreNew(data.has_more);
          if (!data.has_more) break;
        }
      } finally {
        newerBusy.current = false;
        if (alive.current) setChecking(false);
      }
    },
    [projectId, storyId, turnId],
  );

  useEffect(() => {
    if (initiallyOpen) void load();
  }, [initiallyOpen, load]);
  const runActive = run?.turn.state === "running" || run?.turn.state === "queued";
  const pollingInterval = runActive ? (run?.progress?.phase === "agent" ? 2_000 : 4_000) : 8_000;
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void checkNew(true);
    };
    const timer = setInterval(refresh, pollingInterval);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, checkNew, pollingInterval]);

  const transcript = open ? transcriptItems(merge(items, pending)) : [];
  const transcriptRef = useRef<HTMLOListElement>(null);
  const followTranscript = useRef(true);
  const latestTranscriptSeq = transcript[0]?.seq;
  useLayoutEffect(() => {
    const list = transcriptRef.current;
    if (open && latestTranscriptSeq !== undefined && list && followTranscript.current)
      list.scrollTop = 0;
  }, [open, latestTranscriptSeq]);
  const history = items.filter((item) => item.type !== "engine.reply_text");
  const pendingHistory = pending.filter((item) => item.type !== "engine.reply_text");
  const control = buttonClassName({
    className: "focus-visible:outline-2 focus-visible:outline-(--info)",
  });
  return (
    <details
      className="group border-t border-(--line) pt-3"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === openState.current) return;
        openState.current = next;
        setOpen(next);
        if (next && !loaded.current) void load();
        else if (next) void checkNew();
      }}
    >
      <summary className="min-h-11 cursor-pointer list-none py-3 text-[12.5px] text-(--mut) hover:text-(--ink)">
        <span
          aria-hidden="true"
          className="mr-1.5 inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        Run details
        {progressMessages !== null && progressMessages > 0
          ? ` · ${progressMessages} progress message${progressMessages === 1 ? "" : "s"}`
          : ""}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {open && run ? <RunProgress {...run} /> : null}
        {open && run ? (
          <section
            aria-label="Live transcript"
            className="grid gap-2 rounded-lg border border-(--line) p-3"
          >
            <h4 className="text-sm font-medium text-(--ink)">Live transcript</h4>
            {transcript.length ? (
              <ol
                ref={transcriptRef}
                className="grid max-h-96 gap-3 overflow-y-auto"
                onScroll={(event) => {
                  followTranscript.current = event.currentTarget.scrollTop <= 24;
                }}
              >
                {transcript.map((item) => (
                  <li
                    key={transcriptKey(item)}
                    className="border-t border-(--line) pt-2 first:border-t-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="text-xs font-medium text-(--ink)">{item.title}</p>
                      <time
                        className="font-mono text-[10px] text-(--dim)"
                        dateTime={item.created_at}
                      >
                        {transcriptTime.format(new Date(item.created_at))}
                      </time>
                    </div>
                    {item.transcript_text || item.text ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-(--mut)">
                        {item.transcript_text ?? item.text}
                      </p>
                    ) : null}
                    {item.transcript_excerpt ? (
                      <p className="mt-1 text-xs text-(--mut)">Excerpt</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-(--mut)">
                {runActive
                  ? "Waiting for agent messages or tool activity."
                  : "No transcript activity was recorded."}
              </p>
            )}
            {cursor !== null ? (
              <button
                type="button"
                className="w-fit text-xs text-(--info) underline"
                disabled={state === "loading"}
                onClick={() => {
                  followTranscript.current = false;
                  void load(cursor);
                }}
              >
                Load earlier activity
              </button>
            ) : null}
          </section>
        ) : null}
        <p className="text-xs text-(--mut)">
          Recorded engine activity, newest first. While open, this view checks for updates. New
          items stay separate until you show them, so your reading position and opened evidence
          remain in place.
        </p>
        <div className="flex min-h-11 flex-wrap items-center gap-3">
          <button
            type="button"
            className={control}
            aria-disabled={pendingHistory.length === 0}
            onClick={() => {
              if (!pendingHistory.length) return;
              const fresh = pendingItems.current;
              pendingItems.current = [];
              setPending([]);
              setItems((current) => merge(current, fresh));
            }}
          >
            Show new activity ({pendingHistory.length})
          </button>
          <button
            type="button"
            className={control}
            aria-disabled={checking || !loaded.current}
            aria-busy={checking}
            onClick={() => void checkNew()}
          >
            Check now
          </button>
          <span role={open ? "status" : undefined} className="text-xs text-(--mut)">
            {moreNew
              ? "More new activity available; check again to continue."
              : pendingHistory.length
                ? `${pendingHistory.length} new items ready.`
                : "No new items waiting to be shown."}
          </span>
        </div>
        {refreshError ? (
          <p role="alert" className="text-sm text-(--bad)">
            Could not update activity — {refreshError}
          </p>
        ) : null}
        {history.length === 0 && state === "end" ? (
          <p className="text-sm text-(--mut)">No activity was recorded for this run.</p>
        ) : (
          <ol className="rounded-lg flex flex-col border border-(--line)">
            {history.map((item) => (
              <ActivityRow
                key={item.seq}
                item={item}
                projectId={projectId}
                storyId={storyId}
                turnId={turnId}
              />
            ))}
          </ol>
        )}
        {open || loaded.current ? (
          <LoadMore
            state={state}
            label="Older activity"
            endLabel={items.length > 0 ? "Start of this run." : ""}
            error={error}
            onLoad={() => void load(cursor ?? undefined)}
          />
        ) : null}
      </div>
    </details>
  );
}

function transcriptKey(item: StoryActivityItem) {
  return item.stream_id !== undefined && (item.kind === "message" || item.kind === "result")
    ? `stream-${item.stream_id}`
    : `event-${item.seq}`;
}

function transcriptItems(newestFirst: StoryActivityItem[]) {
  const entries = new Map<string, StoryActivityItem>();
  let last: StoryActivityItem | undefined;
  for (const item of newestFirst.toReversed()) {
    if (
      !item.type.startsWith("engine.") ||
      !["message", "reasoning", "tool", "command", "file_change", "result", "error"].includes(
        item.kind,
      )
    )
      continue;
    if (item.kind === "message" && !item.text) continue;
    if (
      item.kind === "result" &&
      last?.kind === "message" &&
      (item.transcript_text ?? item.text) === (last.transcript_text ?? last.text) &&
      !item.transcript_excerpt &&
      !last.transcript_excerpt
    )
      entries.delete(transcriptKey(last));
    entries.set(transcriptKey(item), item);
    last = item;
  }
  return [...entries.values()].sort((a, b) => b.seq - a.seq);
}

const RUN_PHASES = [
  { id: "credentials", label: "GitHub access" },
  { id: "workspace", label: "Workspace" },
  { id: "environment", label: "Project environment" },
  { id: "agent", label: "Agent" },
] as const;

function RunProgress({ turn, progress }: Pick<StoryTurnActivityPage, "turn" | "progress">) {
  const active = turn.state === "running";
  const ticking = active || turn.state === "queued";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const phaseIndex = RUN_PHASES.findIndex((phase) => phase.id === progress?.phase);
  const done = turn.state === "succeeded";
  const title = done
    ? "Run completed"
    : turn.state === "queued"
      ? "Waiting for a worker"
      : active
        ? (progress?.title ?? "Starting the run")
        : turn.state === "canceled"
          ? "Run canceled"
          : "Run stopped";
  const detail = active
    ? progress?.detail
    : turn.state === "queued"
      ? "Facility will begin when a worker picks up this run."
      : !done && progress
        ? `Last step: ${progress.title}`
        : undefined;
  const from = Date.parse((active && progress?.started_at) || turn.startedAt || turn.createdAt);
  const until = turn.endedAt ? Date.parse(turn.endedAt) : now;
  const seconds = Math.max(0, Math.floor((until - from) / 1_000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const percent = active ? (progress?.percent ?? null) : null;
  const updateAge = progress
    ? Math.max(0, Math.floor((now - Date.parse(progress.updated_at)) / 1_000))
    : null;

  return (
    <section
      aria-label="Run progress"
      className="grid gap-3 rounded-lg border border-(--line) bg-(--bg-subtle) p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-(--ink)" aria-live="polite">
          {title}
        </p>
        {Number.isFinite(seconds) ? (
          <span className="font-mono text-xs text-(--mut)">{elapsed}</span>
        ) : null}
      </div>
      {detail ? <p className="text-xs text-(--mut)">{detail}</p> : null}
      {active ? (
        <div className="flex items-center gap-2">
          <progress
            aria-label={percent === null ? title : `${title}: ${progress?.detail}`}
            className="h-2 w-full accent-(--info)"
            max={100}
            value={percent ?? undefined}
          />
          {percent !== null ? (
            <span className="font-mono text-xs text-(--ink)">{percent}%</span>
          ) : null}
        </div>
      ) : null}
      {progress ? (
        <p className="text-xs text-(--mut)">
          Last update{" "}
          <time dateTime={progress.updated_at} title={formatTime(progress.updated_at)}>
            {active && updateAge !== null && Number.isFinite(updateAge)
              ? updateAge < 60
                ? `${updateAge}s ago`
                : `${Math.floor(updateAge / 60)}m ago`
              : formatTime(progress.updated_at)}
          </time>
        </p>
      ) : null}
      {phaseIndex >= 0 || done ? (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {RUN_PHASES.map((phase, index) => {
            const status =
              done || index < phaseIndex
                ? "Complete"
                : index === phaseIndex
                  ? active
                    ? "In progress"
                    : "Stopped"
                  : "Pending";
            return (
              <li
                key={phase.id}
                aria-current={status === "In progress" ? "step" : undefined}
                className={status === "In progress" ? "font-medium text-(--ink)" : "text-(--mut)"}
              >
                <span aria-hidden="true" className="mr-1">
                  {status === "Complete"
                    ? "✓"
                    : status === "Stopped"
                      ? "!"
                      : status === "In progress"
                        ? "▶"
                        : "○"}
                </span>
                <span className="sr-only">{status}: </span>
                {phase.label}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function ActivityRow({
  item,
  projectId,
  storyId,
  turnId,
}: {
  item: StoryActivityItem;
  projectId: string;
  storyId: string;
  turnId: string;
}) {
  const [raw, setRaw] = useState<StoryTurnEvent | null>(null);
  const [rawState, setRawState] = useState<"idle" | "loading" | "error">("idle");
  const [rawError, setRawError] = useState("");
  const tone =
    item.kind === "error"
      ? "text-(--bad)"
      : item.kind === "result"
        ? "text-(--ok)"
        : item.kind === "message"
          ? "text-(--accent-ink)"
          : "text-(--mut)";

  async function loadRaw() {
    setRawState("loading");
    setRawError("");
    const result = await clientApi<StoryTurnEvent>(
      "GET",
      storyTurnEventPath(projectId, storyId, turnId, item.seq),
    );
    if (!result.ok) {
      setRawState("error");
      setRawError(result.message);
      return;
    }
    setRaw(result.data);
    setRawState("idle");
  }

  return (
    <li className="grid gap-1 border-b border-(--line) p-3 last:border-b-0 sm:grid-cols-[24px_minmax(0,1fr)_auto]">
      <span aria-hidden="true" className={`font-mono text-[12px] ${tone}`}>
        {KIND_GLYPH[item.kind]}
      </span>
      <div className="min-w-0">
        <p className="text-[12.5px] text-(--ink)">
          <span className="sr-only">{item.kind.replaceAll("_", " ")}: </span>
          {item.title}
        </p>
        {item.text ? (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-(--mut)">
            {item.text}
          </pre>
        ) : null}
        {item.truncated || raw ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            {item.truncated && !raw ? (
              <span className="text-(--dim)">
                Shortened here · {formatBytes(item.size_bytes)} stored
              </span>
            ) : null}
            {!raw ? (
              <button
                type="button"
                onClick={loadRaw}
                disabled={rawState === "loading"}
                className="text-(--info) underline-offset-4 hover:underline disabled:opacity-60"
              >
                {rawState === "loading" ? "loading…" : "Load the full stored event"}
              </button>
            ) : null}
            {rawState === "error" ? (
              <span role="alert" className="text-(--bad)">
                {rawError}
              </span>
            ) : null}
          </div>
        ) : null}
        {raw ? (
          <pre className="rounded-md mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all border border-(--line) bg-(--bg-subtle) p-3 font-mono text-[10.5px] leading-relaxed text-(--mut)">
            {JSON.stringify(raw.data, null, 2)}
          </pre>
        ) : null}
      </div>
      <time className="font-mono text-[10px] text-(--dim)" dateTime={item.created_at}>
        {formatTime(item.created_at)}
      </time>
    </li>
  );
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}
