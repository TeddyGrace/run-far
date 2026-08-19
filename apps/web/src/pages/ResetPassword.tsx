import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    if (!token) {
      setError("This reset link is invalid or missing.");
      return;
    }
    setSubmitting(true);
    try {
      const user = await api.post("/auth/reset-password", { token, password });
      queryClient.setQueryData(["auth", "me"], user);
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong resetting your password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-0 px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative w-full max-w-sm animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Choose a new password
        </h1>

        {!token ? (
          <p className="mb-8 text-sm leading-relaxed text-zone-red">
            This reset link is invalid or missing.{" "}
            <Link to="/forgot-password" className="underline-offset-4 hover:underline">
              Request a new one
            </Link>
            .
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm text-ink-secondary">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={10}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary placeholder:text-ink-muted"
              />
              <p className="mt-1 text-xs text-ink-muted">At least 10 characters.</p>
            </div>
            <div>
              <label htmlFor="confirm" className="mb-1.5 block text-sm text-ink-secondary">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary placeholder:text-ink-muted"
              />
            </div>
            {error && (
              <p className="text-sm text-zone-red" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-accent px-3 py-2 font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save new password"}
            </button>
          </form>
        )}

        <p className="mt-10 text-sm text-ink-muted">
          <Link
            to="/login"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Back to sign in
          </Link>
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
