import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth, useLogout } from "../lib/auth.js";

export function PendingApproval() {
  const { user } = useAuth();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    setChecking(false);
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
          Pending approval
        </h1>
        <p className="mb-1 text-sm leading-relaxed text-ink-secondary">
          run-far is currently invite-only, and{" "}
          {user?.email ? <span className="font-medium text-ink-primary">{user.email}</span> : "your account"}{" "}
          is waiting on approval.
        </p>
        <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
          You'll be let in automatically as soon as it's approved. You can check now, or sign
          out for the moment.
        </p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={checkAgain}
            disabled={checking}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2.5 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {checking ? "Checking…" : "Check again"}
          </button>
          <button
            type="button"
            onClick={() => logout()}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2.5 text-sm font-medium text-ink-primary transition-[border-color,background-color] duration-200 hover:border-accent/50 hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
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
