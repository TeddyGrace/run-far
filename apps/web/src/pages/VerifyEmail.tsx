import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";

export function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"loading" | "ok" | "error">(token ? "loading" : "error");
  const [message, setMessage] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    api
      .post("/auth/verify-email", { token })
      .then((user) => {
        queryClient.setQueryData(["auth", "me"], user);
        queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
        setStatus("ok");
      })
      .catch((err) => {
        setMessage(err instanceof ApiError ? err.message : "Something went wrong verifying your email");
        setStatus("error");
      });
  }, [token, queryClient]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-0 px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative w-full max-w-sm animate-[fade-up_0.5s_ease-out] text-center">
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>

        {status === "loading" && (
          <p className="text-sm text-ink-secondary">Verifying your email…</p>
        )}

        {status === "ok" && (
          <>
            <h1 className="mb-2 font-display text-2xl font-semibold text-ink-primary">Email verified</h1>
            <p className="mb-6 text-sm leading-relaxed text-ink-secondary">
              Taking you to run-far now.
            </p>
            <Link
              to="/"
              className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-surface-0 hover:opacity-90"
            >
              Continue
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <h1 className="mb-2 font-display text-2xl font-semibold text-ink-primary">Link invalid</h1>
            <p className="mb-6 text-sm leading-relaxed text-zone-red">
              {message ?? "This verification link is invalid or missing."}
            </p>
            <Link
              to="/login"
              className="text-sm text-ink-secondary underline-offset-4 hover:text-ink-primary hover:underline"
            >
              Back to sign in
            </Link>
          </>
        )}
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
