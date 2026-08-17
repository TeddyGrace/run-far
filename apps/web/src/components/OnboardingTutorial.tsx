import { useEffect, useLayoutEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../lib/api.js";
import type { CurrentUser } from "../lib/auth.js";

interface Step {
  title: string;
  body: string;
  visual: React.ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Connect Whoop",
    body: "Link your Whoop account in Settings to pull in recovery, sleep, and strain data automatically. Your recovery score drives the recommendation you see on the Dashboard every morning.",
    visual: (
      <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-medium text-accent">
        <span className="h-2 w-2 rounded-full bg-accent" />
        Whoop
      </span>
    ),
  },
  {
    title: "Sync your Google Calendar",
    body: "Connect Google Calendar to keep a dedicated running calendar in sync both ways. When there's a conflict, the plan in run-far always wins, so your training schedule stays the source of truth.",
    visual: (
      <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-medium text-accent">
        <span className="h-2 w-2 rounded-full bg-accent" />
        Google Calendar
      </span>
    ),
  },
  {
    title: "Share your location for weather",
    body: "Set your location once in Settings and we'll pull local weather into your Dashboard and factor it into run recommendations — heat, wind, and storms included.",
    visual: (
      <svg viewBox="0 0 24 24" className="h-9 w-9 text-accent" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 21s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z"
        />
        <circle cx="12" cy="9" r="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: "Build a plan with AI",
    body: "Head to Build and describe your race, goal, or weekly mileage in plain language. The AI drafts a full training plan you can review and tweak before committing it to your calendar.",
    visual: (
      <div className="max-w-[14rem] rounded-xl rounded-bl-sm border border-border bg-surface-2 px-3 py-2 text-left text-xs text-ink-secondary">
        "Build me a 12-week half marathon plan, peaking mid-October…"
      </div>
    ),
  },
  {
    title: "Ask the assistant anything",
    body: "The assistant is always one click away in the bottom-right corner of every page. Ask about your recovery, upcoming runs, or say something like \"move Thursday's run earlier\" — it can propose calendar changes for you to confirm.",
    visual: (
      <div className="relative h-16 w-full">
        <span className="absolute bottom-0 right-0 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-surface-0 shadow-lg">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
            />
          </svg>
        </span>
      </div>
    ),
  },
];

export function OnboardingTutorial() {
  const qc = useQueryClient();
  const [stepIndex, setStepIndex] = useState(0);
  // Flips true a frame after mount so the entrance transition animates from its initial
  // (hidden) styles instead of snapping straight to visible — same pattern as AssistantChat.
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const complete = useMutation({
    mutationFn: () => api.post("/settings/tutorial-complete"),
    onSuccess: () => {
      qc.setQueryData<CurrentUser>(["auth", "me"], (old) => (old ? { ...old, needsTutorial: false } : old));
    },
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") complete.mutate();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = STEPS[stepIndex]!;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome tutorial"
      className={clsx(
        "fixed inset-0 z-50 flex items-center justify-center bg-surface-0/80 p-4 backdrop-blur-sm transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={clsx(
          "w-full max-w-lg rounded-xl border border-border bg-surface-1 p-8 shadow-2xl transition-all duration-200 ease-out",
          visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-3 scale-95 opacity-0",
        )}
      >
        <div className="mb-6 flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={clsx(
                "h-1.5 rounded-full transition-all duration-200",
                i === stepIndex ? "w-6 bg-accent" : "w-1.5 bg-border",
              )}
            />
          ))}
        </div>

        <div key={stepIndex} className="animate-[fade-up_0.3s_ease-out] text-center">
          <div className="mb-5 flex justify-center">{step.visual}</div>
          <h2 className="mb-2 font-display text-xl font-semibold text-ink-primary">{step.title}</h2>
          <p className="text-sm leading-relaxed text-ink-secondary">{step.body}</p>
        </div>

        <div className="mt-8 flex items-center justify-between">
          <button
            type="button"
            onClick={() => complete.mutate()}
            className="text-sm font-medium text-ink-muted hover:text-ink-secondary"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => setStepIndex((i) => i - 1)}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink-secondary hover:text-ink-primary"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? complete.mutate() : setStepIndex((i) => i + 1))}
              disabled={complete.isPending}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
            >
              {isLast ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fade-up {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
