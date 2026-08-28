import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import type {
  ApplyScheduleChangesResponse,
  ChatMessage,
  ChatSessionWithPreview,
  ChatStreamEvent,
  ScheduleChangeItem,
  ScheduleChangeProposal,
} from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { Markdown } from "./Markdown.js";

interface SessionMessagesResponse {
  session: { id: string; title: string; createdAt: string; updatedAt: string };
  messages: ChatMessage[];
}

const STARTER_PROMPTS = [
  "How's my recovery today?",
  "Move Thursday's run earlier",
  "Is this a good week to add mileage?",
];

/** A mountain-range glyph — the coach's mark, standing in for an avatar. */
function PeakMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 19.5l6-10 4 5.5 2.5-4 6.5 8.5" />
      <circle cx="17" cy="4.75" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function AssistantChat() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Panel stays mounted slightly past `open` going false so the closing transition can play,
  // and `visible` flips a frame after mount so the opening transition animates from its
  // initial (closed) styles instead of snapping straight to open.
  const [panelMounted, setPanelMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] = useState<{
    proposal: ScheduleChangeProposal;
    token: string;
    sessionId: string;
  } | null>(null);
  const [appliedTokens, setAppliedTokens] = useState<Set<string>>(new Set());

  // In-flight streaming turn (local, cleared once the persisted messages are refetched).
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSentRef = useRef<string>("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  const sessionsQuery = useQuery({
    queryKey: ["assistant", "sessions"],
    queryFn: () => api.get<{ items: ChatSessionWithPreview[] }>("/assistant/sessions"),
    enabled: open,
  });

  const messagesQuery = useQuery({
    queryKey: ["assistant", "messages", activeSessionId],
    queryFn: () => api.get<SessionMessagesResponse>(`/assistant/sessions/${activeSessionId}/messages`),
    enabled: open && !!activeSessionId,
  });

  const messages = messagesQuery.data?.messages ?? [];

  // Auto-stick to the bottom while streaming, but only if the reader hasn't scrolled up.
  useEffect(() => {
    if (stuckToBottom) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messagesQuery.data, streamText, activity, optimisticUser, pendingProposal, stuckToBottom]);

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

  useEffect(() => {
    if (open) {
      setPanelMounted(true);
    } else {
      setVisible(false);
      const t = setTimeout(() => setPanelMounted(false), 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Flips to true one paint after mount so the transition animates from the closed styles
  // rather than starting already-open.
  useLayoutEffect(() => {
    if (!panelMounted) return;
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [panelMounted]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const createSession = useMutation({
    mutationFn: () => api.post<{ id: string }>("/assistant/sessions", {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["assistant", "sessions"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't start a new chat"),
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.delete(`/assistant/sessions/${id}`),
    onSuccess: (_data, id) => {
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setPendingProposal(null);
      }
      void qc.invalidateQueries({ queryKey: ["assistant", "sessions"] });
    },
  });

  const renameSession = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch(`/assistant/sessions/${id}`, { title }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["assistant", "sessions"] }),
  });

  const apply = useMutation({
    mutationFn: (token: string) =>
      api.post<ApplyScheduleChangesResponse>("/assistant/apply", { proposalToken: token }),
    onSuccess: (_data, token) => {
      setAppliedTokens((prev) => new Set(prev).add(token));
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["plans"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't apply those changes"),
  });

  function clearTurn() {
    setStreaming(false);
    setStreamText("");
    setActivity([]);
    setOptimisticUser(null);
  }

  async function runStream(sessionId: string, content: string) {
    lastSentRef.current = content;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setPendingProposal((p) => (p?.sessionId === sessionId ? null : p));
    setStreaming(true);
    setStreamText("");
    setActivity([]);
    setOptimisticUser(content);
    setStuckToBottom(true);

    let doneEvent: Extract<ChatStreamEvent, { type: "done" }> | null = null;
    let errorEvent: Extract<ChatStreamEvent, { type: "error" }> | null = null;

    try {
      await api.stream<ChatStreamEvent>(
        `/assistant/sessions/${sessionId}/chat/stream`,
        { content },
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
            case "proposal":
              setPendingProposal({ proposal: event.proposal, token: event.proposalToken, sessionId });
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
      if (controller.signal.aborted) return; // switched sessions mid-stream; nothing to show
      setError(err instanceof ApiError ? err.message : "The assistant didn't respond");
      clearTurn();
      return;
    }

    if (errorEvent) {
      setError((errorEvent as { message: string }).message);
      clearTurn();
      return;
    }

    // Write the finished turn straight into the cache and clear the local turn in the same
    // commit — so the streamed content is replaced by the persisted messages with no gap and,
    // crucially, no frame where the optimistic bubble and the refetched one both show. A
    // background refetch then reconciles the synthesized user id with the server's.
    const done = doneEvent as Extract<ChatStreamEvent, { type: "done" }> | null;
    if (done) {
      qc.setQueryData<SessionMessagesResponse>(["assistant", "messages", sessionId], (prev) => {
        const userMsg: ChatMessage = {
          id: `local-user-${Date.now()}`,
          role: "user",
          content,
          createdAt: new Date(new Date(done.assistantMessage.createdAt).getTime() - 1000).toISOString(),
        };
        const base = prev ?? {
          session: done.session,
          messages: [] as ChatMessage[],
        };
        return { ...base, session: done.session, messages: [...base.messages, userMsg, done.assistantMessage] };
      });
    }
    clearTurn();
    void qc.invalidateQueries({ queryKey: ["assistant", "sessions"] });
    void qc.invalidateQueries({ queryKey: ["assistant", "messages", sessionId] });
  }

  function openSession(id: string) {
    abortRef.current?.abort();
    clearTurn();
    setActiveSessionId(id);
    setShowSessions(false);
    setPendingProposal(null);
    setError(null);
  }

  function startNewChat() {
    abortRef.current?.abort();
    clearTurn();
    setActiveSessionId(null);
    setShowSessions(false);
    setPendingProposal(null);
    setError(null);
    setInput("");
  }

  async function submit(text: string) {
    const content = text.trim();
    if (!content || streaming) return;
    setInput("");
    let sessionId = activeSessionId;
    if (!sessionId) {
      try {
        const created = await createSession.mutateAsync();
        sessionId = created.id;
        setActiveSessionId(created.id);
      } catch {
        setInput(content);
        return;
      }
    }
    void runStream(sessionId, content);
  }

  function retry() {
    if (activeSessionId && lastSentRef.current) void runStream(activeSessionId, lastSentRef.current);
  }

  const activeTitle = activeSessionId
    ? (sessionsQuery.data?.items.find((s) => s.id === activeSessionId)?.title ?? "New conversation")
    : "New conversation";
  const showEmpty = !activeSessionId && !streaming && !optimisticUser;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-surface-0 shadow-lg transition-transform hover:scale-105"
        aria-label={open ? "Close coach chat" : "Open coach chat"}
        aria-expanded={open}
      >
        {open ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <PeakMark className="h-5 w-5" />
        )}
      </button>

      {panelMounted && (
        <div
          role="dialog"
          aria-label="Coach chat"
          className={clsx(
            "fixed z-40 flex flex-col overflow-hidden border border-border bg-surface-0 shadow-2xl",
            "inset-x-0 bottom-0 h-[88vh] max-h-[88vh] w-full rounded-t-2xl",
            "sm:inset-auto sm:bottom-20 sm:right-5 sm:h-[34rem] sm:w-[27rem] sm:max-w-[calc(100vw-2.5rem)] sm:rounded-2xl",
            "origin-bottom transition-all duration-200 ease-out sm:origin-bottom-right",
            visible
              ? "translate-y-0 opacity-100 sm:scale-100"
              : "translate-y-4 opacity-0 sm:translate-y-3 sm:scale-95",
          )}
        >
          <Header
            title={activeTitle}
            showSessions={showSessions}
            onToggleSessions={() => setShowSessions((v) => !v)}
            onNewChat={startNewChat}
            onClose={() => setOpen(false)}
          />

          {showSessions ? (
            <SessionList
              sessions={sessionsQuery.data?.items ?? []}
              loading={sessionsQuery.isLoading}
              activeSessionId={activeSessionId}
              onOpen={openSession}
              onDelete={(id) => deleteSession.mutate(id)}
              onRename={(id, title) => renameSession.mutate({ id, title })}
            />
          ) : (
            <>
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="relative flex-1 space-y-4 overflow-y-auto px-4 py-4"
              >
                {showEmpty && <EmptyState onPick={(p) => void submit(p)} disabled={createSession.isPending} />}

                {messagesQuery.isLoading && activeSessionId && (
                  <p className="font-mono text-xs text-ink-muted">Loading thread…</p>
                )}

                {messages.map((m) => (
                  <MessageRow key={m.id} role={m.role} content={m.content} createdAt={m.createdAt} />
                ))}

                {optimisticUser && <MessageRow role="user" content={optimisticUser} createdAt="" />}

                {streaming && activity.length > 0 && !streamText && <CoachActivity activity={activity} />}

                {streaming && streamText && (
                  <MessageRow role="assistant" content={streamText} createdAt="" streaming />
                )}

                {pendingProposal && pendingProposal.sessionId === activeSessionId && (
                  <ProposalCard
                    proposal={pendingProposal.proposal}
                    applied={appliedTokens.has(pendingProposal.token)}
                    applying={apply.isPending}
                    onApply={() => apply.mutate(pendingProposal.token)}
                    onDecline={() => setPendingProposal(null)}
                  />
                )}
              </div>

              {!stuckToBottom && (
                <button
                  type="button"
                  onClick={jumpToLatest}
                  className="absolute bottom-[4.75rem] left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs font-medium text-ink-secondary shadow-lg hover:text-ink-primary"
                >
                  Jump to latest ↓
                </button>
              )}

              {error && (
                <div className="flex items-center justify-between gap-2 border-t border-zone-red/30 bg-zone-red/5 px-4 py-2">
                  <p className="text-xs text-zone-red">{error}</p>
                  {lastSentRef.current && (
                    <button
                      type="button"
                      onClick={retry}
                      className="shrink-0 rounded-md border border-zone-red/40 px-2 py-1 text-xs font-medium text-zone-red hover:bg-zone-red/10"
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}

              <Composer
                value={input}
                onChange={setInput}
                onSend={() => void submit(input)}
                disabled={streaming || createSession.isPending}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}

function Header({
  title,
  showSessions,
  onToggleSessions,
  onNewChat,
  onClose,
}: {
  title: string;
  showSessions: boolean;
  onToggleSessions: () => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent-strong">
        <PeakMark className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-semibold leading-tight text-ink-primary">Coach</p>
        <p className="truncate text-xs text-ink-muted">{title}</p>
      </div>
      <IconButton label={showSessions ? "Hide chats" : "Chat history"} onClick={onToggleSessions} active={showSessions}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
      </IconButton>
      <IconButton label="New chat" onClick={onNewChat}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
      </IconButton>
      <IconButton label="Close" onClick={onClose}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        active ? "bg-surface-2 text-ink-primary" : "text-ink-muted hover:bg-surface-1 hover:text-ink-primary",
      )}
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2}>
        {children}
      </svg>
    </button>
  );
}

function MessageRow({
  role,
  content,
  createdAt,
  streaming,
}: {
  role: ChatMessage["role"];
  content: string;
  createdAt: string;
  streaming?: boolean;
}) {
  const time = formatTime(createdAt);
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
  // Coach: no bubble — notes flush against a thin accent pace-line.
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

/** The signature element: a live readout of the data the coach is consulting, ticking in like
 * splits. The most recent line is active; earlier lines settle to muted. */
function CoachActivity({ activity }: { activity: string[] }) {
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

function EmptyState({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="flex h-full flex-col justify-center gap-4 py-6">
      <div className="border-l-2 border-accent/40 pl-3">
        <p className="text-sm text-ink-secondary">
          I can see your recovery, planned runs, and calendar. Ask me anything — or I'll draft calendar
          changes for you to confirm.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Try asking</span>
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onPick(p)}
            className="group flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-1 px-3.5 py-2.5 text-left text-sm text-ink-primary transition-colors hover:border-accent/40 hover:bg-surface-2 disabled:opacity-50"
          >
            <span>{p}</span>
            <span className="text-ink-muted transition-colors group-hover:text-accent-strong">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
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

  // Autosize: grow with content up to ~5 lines, then scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  return (
    <div className="flex items-end gap-2 border-t border-border p-3">
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
        placeholder="Ask your coach…"
        className="max-h-[120px] min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-surface-1 px-3.5 py-2.5 text-base text-ink-primary placeholder:text-ink-muted sm:text-sm"
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

function SessionList({
  sessions,
  loading,
  activeSessionId,
  onOpen,
  onDelete,
  onRename,
}: {
  sessions: ChatSessionWithPreview[];
  loading: boolean;
  activeSessionId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commitRename(id: string) {
    const title = draft.trim();
    if (title) onRename(id, title);
    setRenamingId(null);
  }

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {loading && <p className="p-2 font-mono text-xs text-ink-muted">Loading chats…</p>}
      {!loading && sessions.length === 0 && (
        <p className="p-3 text-sm text-ink-muted">No saved chats yet. Start one from the composer.</p>
      )}
      <ul className="space-y-1">
        {sessions.map((s) => (
          <li key={s.id}>
            <div
              className={clsx(
                "group flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-surface-1",
                s.id === activeSessionId && "bg-surface-1",
              )}
            >
              {renamingId === s.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(s.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={() => commitRename(s.id)}
                  className="min-w-0 flex-1 rounded-md border border-accent/40 bg-surface-0 px-2 py-1 text-sm text-ink-primary"
                />
              ) : (
                <button type="button" onClick={() => onOpen(s.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate font-medium text-ink-primary">{s.title}</div>
                  {s.lastMessagePreview && (
                    <div className="truncate text-xs text-ink-muted">{s.lastMessagePreview}</div>
                  )}
                </button>
              )}
              {renamingId !== s.id && (
                <div className="flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(s.title);
                      setRenamingId(s.id);
                    }}
                    aria-label="Rename chat"
                    title="Rename"
                    className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink-primary"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4 20h4L18 10l-4-4L4 16v4zM14 6l4 4"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(s.id)}
                    aria-label="Delete chat"
                    title="Delete"
                    className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-zone-red"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 7h12M9 7V5h6v2M7 7l1 12h8l1-12"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const OP_LABEL: Record<ScheduleChangeItem["op"], string> = {
  create: "Add",
  update: "Change",
  delete: "Remove",
};

function ProposalCard({
  proposal,
  applied,
  applying,
  onApply,
  onDecline,
}: {
  proposal: ScheduleChangeProposal;
  applied: boolean;
  applying: boolean;
  onApply: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-accent/30 bg-accent/5">
      <div className="flex items-center gap-2 border-b border-accent/20 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-accent-strong">
          Proposed changes
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          {proposal.items.length} edit{proposal.items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="p-3">
        <p className="mb-3 text-sm text-ink-primary">{proposal.summary}</p>
        <ul className="mb-3 space-y-1.5">
          {proposal.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-ink-secondary">
              <span
                className={clsx(
                  "mt-px shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide",
                  item.op === "create" && "bg-zone-good/15 text-zone-good",
                  item.op === "update" && "bg-zone-yellow/15 text-zone-yellow",
                  item.op === "delete" && "bg-zone-red/15 text-zone-red",
                )}
              >
                {OP_LABEL[item.op]}
              </span>
              <span className="pt-0.5">{item.summary}</span>
            </li>
          ))}
        </ul>
        {applied ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-zone-good">
            <span aria-hidden="true">✓</span> Applied to your calendar
          </p>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onApply}
              disabled={applying}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {applying
                ? "Applying…"
                : `Apply ${proposal.items.length} change${proposal.items.length === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              onClick={onDecline}
              disabled={applying}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:text-ink-primary disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
