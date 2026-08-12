import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiPlanDraft,
  ImportPreview,
  PlanAiChatResponse,
  PlanChatMessage,
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

function DescribePlan({
  onCancel,
  onError,
  onSuccess,
}: {
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onSuccess: (data: { inserted: number; updated: number; skipped: number }) => void;
}) {
  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiPlanDraft | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [planName, setPlanName] = useState("");

  const chat = useMutation({
    mutationFn: (nextMessages: PlanChatMessage[]) =>
      api.post<PlanAiChatResponse>("/plans/ai/chat", { messages: nextMessages }),
    onSuccess: (data, nextMessages) => {
      setMessages([...nextMessages, { role: "assistant", content: data.assistantMessage }]);
      if (data.draft && data.draftToken) {
        setDraft(data.draft);
        setDraftToken(data.draftToken);
        setPlanName(data.draft.name);
      }
      onError(null);
    },
    onError: (err) => onError(err instanceof ApiError ? err.message : "Chat failed"),
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ planId: string; inserted: number; updated: number; skipped: number }>(
        "/plans/ai/commit",
        { draftToken: draftToken!, planName },
      ),
    onSuccess: (data) => onSuccess(data),
    onError: (err) => onError(err instanceof ApiError ? err.message : "Couldn't save that plan"),
  });

  function send() {
    const text = input.trim();
    if (!text || chat.isPending) return;
    const next: PlanChatMessage[] = [...messages, { role: "user", content: text }];
    setInput("");
    setMessages(next);
    chat.mutate(next);
  }

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

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Describe your goal, timeline, and available days — or ask to revise your current plan
        (e.g. “move all my runs to 4:30pm”). The coach will propose a plan you can preview
        before it goes on your calendar.
      </p>

      <div className="max-h-80 space-y-3 overflow-y-auto rounded-xl border border-border bg-surface-1 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-ink-muted">
            e.g. “12-week half marathon plan, currently ~25 mi/week, can train Mon–Fri mornings and
            Sunday long run.”
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={`${m.role}-${i}`}
            className={clsx(
              "text-sm",
              m.role === "user" ? "whitespace-pre-wrap text-ink-primary" : "text-ink-secondary",
            )}
          >
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-muted">
              {m.role === "user" ? "You" : "Coach"}
            </span>
            {m.role === "user" ? m.content : <Markdown content={m.content} />}
          </div>
        ))}
        {chat.isPending && <p className="text-sm text-ink-muted">Thinking…</p>}
      </div>

      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Message the coach…"
          className="min-h-[2.75rem] flex-1 resize-y rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-primary"
        />
        <button
          type="button"
          onClick={send}
          disabled={chat.isPending || !input.trim()}
          className="self-end rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          Send
        </button>
      </div>

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
