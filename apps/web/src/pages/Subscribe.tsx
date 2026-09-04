import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth, useLogout } from "../lib/auth.js";
import { api, ApiError } from "../lib/api.js";

const PLANS = [
  { plan: "monthly" as const, label: "Monthly", price: "$6.99", period: "/mo" },
  { plan: "annual" as const, label: "Annual", price: "$59.99", period: "/yr", note: "save ~29%" },
];

export function Subscribe() {
  const { user } = useAuth();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [startingPlan, setStartingPlan] = useState<"monthly" | "annual" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkAgain = async () => {
    setChecking(true);
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    setChecking(false);
  };

  const startCheckout = async (plan: "monthly" | "annual") => {
    setStartingPlan(plan);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>("/billing/checkout", { plan });
      window.location.href = url;
    } catch (err) {
      setStartingPlan(null);
      if (err instanceof ApiError && err.code === "STRIPE_NOT_CONFIGURED") {
        setError("Billing isn't set up yet — check back soon, or ask for a comp in the meantime.");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't start checkout");
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-0 px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative w-full max-w-sm animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Subscribe to continue
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
          {user?.email ? <span className="font-medium text-ink-primary">{user.email}</span> : "Your account"}{" "}
          doesn't have an active subscription. Start a 14-day free trial — a card is required, but you
          won't be charged until the trial ends.
        </p>

        <div className="mb-6 grid grid-cols-2 gap-3">
          {PLANS.map((p) => (
            <button
              key={p.plan}
              type="button"
              onClick={() => startCheckout(p.plan)}
              disabled={startingPlan !== null}
              className="flex flex-col items-start gap-1 rounded-md border border-border bg-surface-1 px-4 py-3 text-left transition-[border-color,background-color] duration-200 hover:border-accent/50 hover:bg-surface-2 disabled:opacity-50"
            >
              <span className="text-xs font-medium text-ink-secondary">{p.label}</span>
              <span className="font-display text-xl font-semibold text-ink-primary">
                {p.price}
                <span className="text-sm font-normal text-ink-muted">{p.period}</span>
              </span>
              {p.note && <span className="text-[11px] text-accent">{p.note}</span>}
              {startingPlan === p.plan && <span className="text-[11px] text-ink-muted">Starting checkout…</span>}
            </button>
          ))}
        </div>

        {error && <p className="mb-4 text-sm text-zone-red">{error}</p>}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={checkAgain}
            disabled={checking}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2.5 text-sm font-medium text-ink-primary transition-[border-color,background-color] duration-200 hover:border-accent/50 hover:bg-surface-2 disabled:opacity-50"
          >
            {checking ? "Checking…" : "I already subscribed — check again"}
          </button>
          <button
            type="button"
            onClick={() => logout()}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2.5 text-sm font-medium text-ink-primary transition-[border-color,background-color] duration-200 hover:border-accent/50 hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>

        <p className="mt-6 flex justify-center gap-4 text-xs text-ink-muted">
          <a href="/terms" className="underline-offset-4 hover:underline">
            Terms
          </a>
          <a href="/privacy" className="underline-offset-4 hover:underline">
            Privacy
          </a>
          <a href="/refunds" className="underline-offset-4 hover:underline">
            Refunds
          </a>
        </p>
      </div>

      <style>{`
        @keyframes fade-up {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
