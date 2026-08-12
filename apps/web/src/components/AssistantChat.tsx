import { useEffect, useRef, useState, useLayoutEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import type {
  ApplyScheduleChangesResponse,
  ChatMessage,
  ChatSessionWithPreview,
  ChatTurnResponse,
  ScheduleChangeProposal,
} from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { Markdown } from "./Markdown.js";

interface SessionMessagesResponse {
  session: { id: string; title: string; createdAt: string; updatedAt: string };
  messages: ChatMessage[];
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
  const scrollRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messagesQuery.data, pendingProposal]);

  useEffect(() => {
    if (open) {
      setPanelMounted(true);
    } else {
      setVisible(false);
      const t = setTimeout(() => setPanelMounted(false), 180);
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

  const createSession = useMutation({
    mutationFn: () => api.post<{ id: string }>("/assistant/sessions", {}),
    onSuccess: (data) => {
      setActiveSessionId(data.id);
      setShowSessions(false);
      setPendingProposal(null);
      void qc.invalidateQueries({ queryKey: ["assistant", "sessions"] });
    },
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

  const send = useMutation({
    // sessionId is passed explicitly rather than read from `activeSessionId` state: when
    // starting a brand-new chat, submit() calls this immediately after setActiveSessionId(),
    // before React has re-rendered — a closure over `activeSessionId` would still see the
    // old `null` and send a literal "null" as the URL's session id.
    mutationFn: ({ sessionId, content }: { sessionId: string; content: string }) =>
      api.post<ChatTurnResponse>(`/assistant/sessions/${sessionId}/chat`, { content }),
    onSuccess: (data, variables) => {
      setPendingProposal(
        data.proposal && data.proposalToken
          ? { proposal: data.proposal, token: data.proposalToken, sessionId: variables.sessionId }
          : null,
      );
      void qc.invalidateQueries({ queryKey: ["assistant", "messages", variables.sessionId] });
      void qc.invalidateQueries({ queryKey: ["assistant", "sessions"] });
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "The assistant didn't respond"),
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

  function startNewChat() {
    createSession.mutate();
  }

  function openSession(id: string) {
    setActiveSessionId(id);
    setShowSessions(false);
    setPendingProposal(null);
  }

  function submit() {
    const text = input.trim();
    if (!text || send.isPending) return;
    if (!activeSessionId) {
      // Create a session first, then send once it exists.
      createSession.mutate(undefined, {
        onSuccess: (data) => {
          setActiveSessionId(data.id);
          setInput("");
          send.mutate({ sessionId: data.id, content: text }, { onError: () => setInput(text) });
        },
      });
      return;
    }
    setInput("");
    send.mutate({ sessionId: activeSessionId, content: text }, { onError: () => setInput(text) });
  }

  const messages = messagesQuery.data?.messages ?? [];
  const optimisticUser =
    send.isPending && send.variables
      ? { id: "pending", role: "user" as const, content: send.variables.content, createdAt: "" }
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-surface-0 shadow-lg transition-transform hover:scale-105"
        aria-label={open ? "Close assistant chat" : "Open assistant chat"}
      >
        {open ? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
            />
          </svg>
        )}
      </button>

      {panelMounted && (
        <div
          className={clsx(
            "fixed bottom-20 right-5 z-40 flex h-[32rem] w-[26rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface-0 shadow-2xl",
            "origin-bottom-right transition-all duration-200 ease-out",
            visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-95 opacity-0",
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowSessions((v) => !v)}
                className="rounded-md px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-1 hover:text-ink-primary"
              >
                Chats
              </button>
              <span className="font-display text-sm font-semibold text-ink-primary">
                {activeSessionId
                  ? (sessionsQuery.data?.items.find((s) => s.id === activeSessionId)?.title ?? "Assistant")
                  : "Assistant"}
              </span>
            </div>
            <button
              type="button"
              onClick={startNewChat}
              disabled={createSession.isPending}
              className="rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:text-ink-primary disabled:opacity-50"
            >
              New chat
            </button>
          </div>

          {showSessions ? (
            <div className="flex-1 overflow-y-auto p-2">
              {sessionsQuery.isLoading && <p className="p-2 text-xs text-ink-muted">Loading…</p>}
              {!sessionsQuery.isLoading && (sessionsQuery.data?.items.length ?? 0) === 0 && (
                <p className="p-2 text-xs text-ink-muted">No saved chats yet.</p>
              )}
              <ul className="space-y-1">
                {sessionsQuery.data?.items.map((s) => (
                  <li key={s.id}>
                    <div
                      className={clsx(
                        "group flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-1",
                        s.id === activeSessionId && "bg-surface-1",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => openSession(s.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate font-medium text-ink-primary">{s.title}</div>
                        {s.lastMessagePreview && (
                          <div className="truncate text-xs text-ink-muted">{s.lastMessagePreview}</div>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteSession.mutate(s.id)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-ink-muted opacity-0 hover:bg-surface-2 hover:text-zone-red group-hover:opacity-100"
                        aria-label="Delete chat"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {!activeSessionId && (
                  <p className="text-sm text-ink-muted">
                    Ask about your recovery, upcoming runs, or say something like "move my Thursday run
                    earlier" — I can see your training data and propose calendar changes for you to confirm.
                  </p>
                )}
                {messagesQuery.isLoading && activeSessionId && (
                  <p className="text-sm text-ink-muted">Loading…</p>
                )}
                {[...messages, ...(optimisticUser ? [optimisticUser] : [])].map((m) => (
                  <div
                    key={m.id}
                    className={clsx("text-sm", m.role === "user" ? "text-ink-primary" : "text-ink-secondary")}
                  >
                    <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                      {m.role === "user" ? "You" : "Assistant"}
                    </span>
                    {m.role === "user" ? (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    ) : (
                      <Markdown content={m.content} />
                    )}
                  </div>
                ))}
                {send.isPending && <p className="text-sm text-ink-muted">Thinking…</p>}

                {pendingProposal && pendingProposal.sessionId === activeSessionId && (
                  <ProposalCard
                    proposal={pendingProposal.proposal}
                    applied={appliedTokens.has(pendingProposal.token)}
                    applying={apply.isPending}
                    onApply={() => apply.mutate(pendingProposal.token)}
                  />
                )}
              </div>

              {error && <p className="px-4 pb-1 text-xs text-zone-red">{error}</p>}

              <div className="flex gap-2 border-t border-border p-3">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={1}
                  placeholder="Ask the assistant…"
                  className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-primary"
                />
                <button
                  type="button"
                  onClick={submit}
                  disabled={send.isPending || createSession.isPending || !input.trim()}
                  className="self-end rounded-md bg-accent px-3 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function ProposalCard({
  proposal,
  applied,
  applying,
  onApply,
}: {
  proposal: ScheduleChangeProposal;
  applied: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-accent">Proposed changes</p>
      <p className="mb-2 text-sm text-ink-primary">{proposal.summary}</p>
      <ul className="mb-3 space-y-1 text-xs text-ink-secondary">
        {proposal.items.map((item, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span
              className={clsx(
                "mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] font-medium uppercase",
                item.op === "create" && "bg-zone-good/15 text-zone-good",
                item.op === "update" && "bg-zone-yellow/15 text-zone-yellow",
                item.op === "delete" && "bg-zone-red/15 text-zone-red",
              )}
            >
              {item.op}
            </span>
            <span>{item.summary}</span>
          </li>
        ))}
      </ul>
      {applied ? (
        <p className="text-xs font-medium text-zone-good">Applied to your calendar.</p>
      ) : (
        <button
          type="button"
          onClick={onApply}
          disabled={applying}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {applying ? "Applying…" : `Apply ${proposal.items.length} change${proposal.items.length === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}
