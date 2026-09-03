import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiPlanDraft,
  ImportPreview,
  PlanChatMessage,
  PlanChatStreamEvent,
  TrainingPlan,
} from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { formatMiles } from "../lib/units.js";
import { Markdown } from "../components/Markdown.js";
import clsx from "clsx";

type AddMode = null | "csv" | "describe";

export function Build() {
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(
    null,
  );
  const [resyncMessage, setResyncMessage] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ["plans", showArchived],
    queryFn: () =>
      api.get<{ items: TrainingPlan[] }>(`/plans${showArchived ? "?includeArchived=1" : ""}`),
  });

  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/plans/${id}/activate`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["plans"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't activate plan"),
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/plans/${id}/archive`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["plans"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't archive plan"),
  });

  const unarchive = useMutation({
    mutationFn: (id: string) => api.post(`/plans/${id}/unarchive`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["plans"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't unarchive plan"),
  });

  const resyncGoogle = useMutation({
    mutationFn: (id: string) =>
      api.post<{ synced: number; failed: number }>(`/plans/${id}/resync-google`, {}),
    onSuccess: (data) => {
      setError(null);
      setResyncMessage(
        `Resynced ${data.synced} run${data.synced === 1 ? "" : "s"} to Google Calendar${
          data.failed ? ` (${data.failed} failed)` : ""
        }`,
      );
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't resync Google Calendar"),
  });

  function onPlanCreated(data: { inserted: number; updated: number; skipped: number }) {
    setResult(data);
    setAddMode(null);
    setError(null);
    void qc.invalidateQueries({ queryKey: ["plans"] });
    void qc.invalidateQueries({ queryKey: ["runs"] });
  }

  const plans = plansQuery.data?.items ?? [];

  return (
    <div className="max-w-2xl space-y-10">
      <div>
        <h1 className="mb-1 font-display text-xl font-semibold text-ink-primary">Build</h1>
        <p className="text-sm text-ink-secondary">
          Store multiple training plans, keep one active on your calendar, or describe a plan and
          refine it with a coach.
        </p>
      </div>

      {error && <p className="text-sm text-zone-red">{error}</p>}

      {result && (
        <p className="text-sm text-ink-primary">
          Saved {result.inserted} run{result.inserted === 1 ? "" : "s"}
          {result.updated > 0 && `, updated ${result.updated}`}
          {result.skipped > 0 && `, skipped ${result.skipped}`}. This plan is now active.
        </p>
      )}

      {resyncMessage && <p className="text-sm text-ink-primary">{resyncMessage}</p>}

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="font-display text-base font-semibold text-ink-primary">Your plans</h2>
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-border"
            />
            Show archived
          </label>
        </div>

        {plansQuery.isLoading && <p className="text-sm text-ink-muted">Loading plans…</p>}
        {!plansQuery.isLoading && plans.length === 0 && (
          <p className="text-sm text-ink-muted">No plans yet — import a CSV or describe your own.</p>
        )}

        <ul className="divide-y divide-border border-y border-border">
          {plans.map((plan) => (
            <li key={plan.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink-primary">{plan.name}</span>
                  <StatusBadge status={plan.status} />
                </div>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {sourceLabel(plan.source)} · {plan.runCount ?? 0} runs ·{" "}
                  {new Date(plan.importedAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {plan.status === "archived" ? (
                  <button
                    type="button"
                    onClick={() => unarchive.mutate(plan.id)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-ink-secondary hover:text-ink-primary"
                  >
                    Unarchive
                  </button>
                ) : (
                  <>
                    {plan.status !== "active" && (
                      <button
                        type="button"
                        onClick={() => activate.mutate(plan.id)}
                        disabled={activate.isPending}
                        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
                      >
                        Activate
                      </button>
                    )}
                    {plan.status === "active" && (
                      <button
                        type="button"
                        onClick={() => {
                          setResyncMessage(null);
                          resyncGoogle.mutate(plan.id);
                        }}
                        disabled={resyncGoogle.isPending}
                        className="rounded-md border border-border px-2.5 py-1 text-xs text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                      >
                        {resyncGoogle.isPending ? "Resyncing…" : "Resync Google Calendar"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => archive.mutate(plan.id)}
                      disabled={archive.isPending}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-ink-secondary hover:text-ink-primary"
                    >
                      Archive
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 font-display text-base font-semibold text-ink-primary">Add a plan</h2>

        {addMode == null && (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                setAddMode("csv");
                setResult(null);
                setError(null);
              }}
              className="rounded-md border border-border bg-surface-1 px-4 py-2 text-sm text-ink-primary hover:border-accent/50"
            >
              Import CSV
            </button>
            <button
              type="button"
              onClick={() => {
                setAddMode("describe");
                setResult(null);
                setError(null);
              }}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90"
            >
              Describe your own
            </button>
          </div>
        )}

        {addMode === "csv" && (
          <CsvImport
            onCancel={() => setAddMode(null)}
            onError={setError}
            onSuccess={onPlanCreated}
          />
        )}

        {addMode === "describe" && (
          <DescribePlan
            onCancel={() => setAddMode(null)}
            onError={setError}
            onSuccess={onPlanCreated}
          />
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: TrainingPlan["status"] }) {
  return (
    <span
      className={clsx(
        "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        status === "active" && "bg-accent/15 text-accent",
        status === "inactive" && "bg-surface-2 text-ink-secondary",
        status === "archived" && "bg-surface-2 text-ink-muted",
      )}
    >
      {status}
    </span>
  );
}

function sourceLabel(source: string): string {
  if (source === "ai_generated") return "Described";
  if (source === "trainingpeaks_csv") return "CSV";
  return source;
}

function CsvImport({
  onCancel,
  onError,
  onSuccess,
}: {
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onSuccess: (data: { inserted: number; updated: number; skipped: number }) => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [planName, setPlanName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const uploadPreview = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api.upload<ImportPreview>("/plans/import/preview", formData);
    },
    onSuccess: (data) => {
      setPreview(data);
      setPlanName(data.planName);
      onError(null);
    },
    onError: (err) => onError(err instanceof ApiError ? err.message : "Couldn't read that file"),
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ planId: string; inserted: number; updated: number; skipped: number }>(
        "/plans/import/commit",
        { uploadToken: preview!.uploadToken, planName },
      ),
    onSuccess: (data) => onSuccess(data),
    onError: (err) => onError(err instanceof ApiError ? err.message : "Couldn't import that plan"),
  });

  function onFileSelected(file: File | null | undefined) {
    if (!file) return;
    uploadPreview.mutate(file);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Upload a TrainingPeaks CSV. Importing activates the plan and replaces the previous active
        plan on your calendar.
      </p>

      {!preview && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFileSelected(e.dataTransfer.files[0]);
          }}
          onClick={() => fileInput.current?.click()}
          className="cursor-pointer rounded-xl border-2 border-dashed border-border bg-surface-1 p-10 text-center transition-colors hover:border-accent/50"
        >
          <p className="text-ink-secondary">
            {uploadPreview.isPending ? "Reading file…" : "Drop a CSV file here, or click to choose one"}
          </p>
          <input
            ref={fileInput}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => onFileSelected(e.target.files?.[0])}
          />
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-ink-secondary">Plan name</label>
            <input
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary"
            />
          </div>
          <PreviewTable
            rows={preview.rows.map((r) => ({
              key: String(r.rowIndex),
              scheduledAt: r.scheduledAt,
              runType: r.runType,
              durationMin: r.durationMin,
              distanceM: r.distanceM,
              warnings: r.warnings.map((w) => w.message).join("; "),
            }))}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => commit.mutate()}
              disabled={commit.isPending}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
            >
              {commit.isPending
                ? "Importing…"
                : `Use plan · ${preview.rows.filter((r) => r.scheduledAt).length} runs`}
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:text-ink-primary"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {!preview && (
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-ink-secondary hover:text-ink-primary"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

const PLAN_STARTER_PROMPTS = [
  "12-week half marathon, currently ~25 mi/week",
  "Move all my runs to weekday evenings",
  "Add a recovery week before my next block",
];

interface DescribeMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

function formatChatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function DescribePlan({
  onCancel,
  onError,
  onSuccess,
}: {
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onSuccess: (data: { inserted: number; updated: number; skipped: number }) => void;
}) {
  const [messages, setMessages] = useState<DescribeMessage[]>([]);
  const [input, setInput] = useState("");
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiPlanDraft | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [planName, setPlanName] = useState("");

  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastMessagesRef = useRef<PlanChatMessage[] | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  useEffect(() => {
    if (stuckToBottom) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages, streamText, activity, stuckToBottom]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setStuckToBottom(nearBottom);
  }

  function jumpToLatest() {
    setStuckToBottom(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }

  function clearTurn() {
    setStreaming(false);
    setStreamText("");
    setActivity([]);
  }

  async function runStream(nextMessages: PlanChatMessage[]) {
    lastMessagesRef.current = nextMessages;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setChatError(null);
    setStreaming(true);
    setStreamText("");
    setActivity([]);
    setStuckToBottom(true);

    let doneEvent: Extract<PlanChatStreamEvent, { type: "done" }> | null = null;
    let errorEvent: Extract<PlanChatStreamEvent, { type: "error" }> | null = null;

    try {
      await api.stream<PlanChatStreamEvent>(
        "/plans/ai/chat/stream",
        { messages: nextMessages },
        (event) => {
          switch (event.type) {
            case "text":
              setStreamText((t) => t + event.delta);
              break;
            case "tool":
              // Text emitted before a tool call is interim, not the answer — drop it and log
              // the activity instead.
              setStreamText("");
              setActivity((a) => [...a, event.label]);
              break;
            case "draft":
              setDraft(event.draft);
              setDraftToken(event.draftToken);
              setPlanName(event.draft.name);
              break;
            case "done":
              doneEvent = event;
              break;
            case "error":
              errorEvent = event;
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a newer send; nothing to show
      setChatError(err instanceof ApiError ? err.message : "The coach didn't respond");
      clearTurn();
      return;
    }

    if (errorEvent) {
      setChatError((errorEvent as { message: string }).message);
      clearTurn();
      return;
    }

    const done = doneEvent as Extract<PlanChatStreamEvent, { type: "done" }> | null;
    if (done) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: done.assistantMessage, createdAt: new Date().toISOString() },
      ]);
    }
    clearTurn();
  }

  function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput("");
    const userMsg: DescribeMessage = { role: "user", content, createdAt: new Date().toISOString() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    void runStream(nextMessages.map((m) => ({ role: m.role, content: m.content })));
  }

  function retry() {
    if (lastMessagesRef.current) void runStream(lastMessagesRef.current);
  }

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ planId: string; inserted: number; updated: number; skipped: number }>(
        "/plans/ai/commit",
        { draftToken: draftToken!, planName },
      ),
    onSuccess: (data) => onSuccess(data),
    onError: (err) => onError(err instanceof ApiError ? err.message : "Couldn't save that plan"),
  });

  if (previewing && draft) {
    return (
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm text-ink-secondary">Plan name</label>
          <input
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary"
          />
        </div>
        {draft.summary && (
          <div className="text-sm text-ink-secondary">
            <Markdown content={draft.summary} />
          </div>
        )}
        <PreviewTable
          rows={draft.runs.map((r, i) => ({
            key: `${r.scheduledAt}-${i}`,
            scheduledAt: r.scheduledAt,
            runType: r.runType,
            durationMin: r.durationMin ?? null,
            distanceM: r.distanceM ?? null,
            warnings: "",
          }))}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => commit.mutate()}
            disabled={commit.isPending || !draftToken}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
          >
            {commit.isPending ? "Saving…" : `Use this plan · ${draft.runs.length} runs`}
          </button>
          <button
            type="button"
            onClick={() => setPreviewing(false)}
            className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:text-ink-primary"
          >
            Keep chatting
          </button>
        </div>
      </div>
    );
  }

  const showEmpty = messages.length === 0 && !streaming;

  return (
    <div className="space-y-3">
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-96 space-y-4 overflow-y-auto rounded-xl border border-border bg-surface-1 p-4"
        >
          {showEmpty && <DescribeEmptyState onPick={(p) => send(p)} disabled={streaming} />}

          {messages.map((m, i) => (
            <DescribeMessageRow key={i} role={m.role} content={m.content} createdAt={m.createdAt} />
          ))}

          {streaming && activity.length > 0 && !streamText && <DescribeActivity activity={activity} />}

          {streaming && streamText && (
            <DescribeMessageRow role="assistant" content={streamText} createdAt="" streaming />
          )}
        </div>

        {!stuckToBottom && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs font-medium text-ink-secondary shadow-lg hover:text-ink-primary"
          >
            Jump to latest ↓
          </button>
        )}
      </div>

      {chatError && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-zone-red/30 bg-zone-red/5 px-3 py-2">
          <p className="text-xs text-zone-red">{chatError}</p>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-md border border-zone-red/40 px-2 py-1 text-xs font-medium text-zone-red hover:bg-zone-red/10"
          >
            Retry
          </button>
        </div>
      )}

      <DescribeComposer value={input} onChange={setInput} onSend={() => send()} disabled={streaming} />

      <div className="flex flex-wrap items-center gap-3">
        {draft && draftToken && (
          <button
            type="button"
            onClick={() => setPreviewing(true)}
            className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/15"
          >
            Preview plan · {draft.runs.length} runs
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-ink-secondary hover:text-ink-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DescribeMessageRow({
  role,
  content,
  createdAt,
  streaming,
}: {
  role: DescribeMessage["role"];
  content: string;
  createdAt: string;
  streaming?: boolean;
}) {
  const time = formatChatTime(createdAt);
  if (role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-sm text-ink-primary">
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
        {time && <span className="mt-1 pr-1 font-mono text-[10px] text-ink-muted">{time}</span>}
      </div>
    );
  }
  return (
    <div className="border-l-2 border-accent/40 pl-3">
      <div className="text-sm text-ink-secondary [&_strong]:text-ink-primary">
        <Markdown content={content} />
        {streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent-strong align-middle" />
        )}
      </div>
      {time && <span className="mt-1 block font-mono text-[10px] text-ink-muted">{time}</span>}
    </div>
  );
}

/** Live readout of the tools the coach is consulting while drafting, ticking in like splits. */
function DescribeActivity({ activity }: { activity: string[] }) {
  return (
    <div className="border-l-2 border-accent/40 pl-3">
      <ul className="space-y-1.5">
        {activity.map((label, i) => {
          const active = i === activity.length - 1;
          return (
            <li key={i} className="flex items-center gap-2 font-mono text-xs">
              <span className="flex h-2 w-2 items-center justify-center">
                {active ? (
                  <span className="flex gap-[2px]">
                    <span className="h-2 w-[2px] animate-pulse rounded bg-accent-strong" />
                    <span
                      className="h-2 w-[2px] animate-pulse rounded bg-accent-strong"
                      style={{ animationDelay: "150ms" }}
                    />
                    <span
                      className="h-2 w-[2px] animate-pulse rounded bg-accent-strong"
                      style={{ animationDelay: "300ms" }}
                    />
                  </span>
                ) : (
                  <span className="text-accent">✓</span>
                )}
              </span>
              <span className={active ? "text-ink-secondary" : "text-ink-muted line-through decoration-border"}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DescribeEmptyState({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="border-l-2 border-accent/40 pl-3">
        <p className="text-sm text-ink-secondary">
          Describe your goal, timeline, and available days — or ask to revise your current plan
          (e.g. "move all my runs to 4:30pm"). I'll propose a plan you can preview before it goes
          on your calendar.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Try asking</span>
        {PLAN_STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onPick(p)}
            className="group flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-left text-sm text-ink-primary transition-colors hover:border-accent/40 hover:bg-surface-0 disabled:opacity-50"
          >
            <span>{p}</span>
            <span className="text-ink-muted transition-colors group-hover:text-accent-strong">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DescribeComposer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={1}
        placeholder="Message the coach…"
        className="max-h-[120px] min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border bg-surface-1 px-3.5 py-2.5 text-base text-ink-primary placeholder:text-ink-muted sm:text-sm"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        aria-label="Send message"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

function PreviewTable({
  rows,
}: {
  rows: Array<{
    key: string;
    scheduledAt: string | null;
    runType: string | null;
    durationMin: number | null;
    distanceM: number | null;
    warnings: string;
  }>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-ink-secondary">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Start time</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Distance</th>
            {rows.some((r) => r.warnings) && (
              <th className="px-3 py-2 font-medium">Warnings</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface-1">
          {rows.map((row) => (
            <tr key={row.key} className={row.scheduledAt == null ? "opacity-50" : undefined}>
              <td className="px-3 py-2 font-mono text-ink-primary">
                {row.scheduledAt ? new Date(row.scheduledAt).toLocaleDateString() : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-ink-primary">
                {row.scheduledAt
                  ? new Date(row.scheduledAt).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })
                  : "—"}
              </td>
              <td className="px-3 py-2 capitalize text-ink-secondary">{row.runType ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-ink-secondary">
                {row.durationMin != null ? `${row.durationMin}min` : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-ink-secondary">
                {row.distanceM != null ? formatMiles(row.distanceM, 1) : "—"}
              </td>
              {rows.some((r) => r.warnings) && (
                <td className="px-3 py-2 text-zone-yellow">{row.warnings}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
