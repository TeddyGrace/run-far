import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";

const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  google_denied: "Google sign-in was cancelled.",
  google_invalid: "Google sign-in failed — try again.",
  google_failed: "Could not complete Google sign-in.",
};

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const oauthError = useMemo(() => {
    const code = searchParams.get("error");
    return code ? (GOOGLE_ERROR_MESSAGES[code] ?? "Sign-in failed.") : null;
  }, [searchParams]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await api.post("/auth/login", { email, password });
      queryClient.setQueryData(["auth", "me"], user);
      const from = (location.state as { from?: Location })?.from?.pathname ?? "/";
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong signing you in");
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
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.22em] text-accent">run far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Sign in
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
          Continue with Google to open today&apos;s readiness and sync your Running calendar.
        </p>

        <a
          href="/api/auth/google/start"
          className="group flex w-full items-center justify-center gap-3 rounded-md border border-border bg-surface-1 px-3 py-2.5 text-sm font-medium text-ink-primary transition-[border-color,background-color,transform] duration-200 hover:border-accent/50 hover:bg-surface-2 active:scale-[0.99]"
        >
          <GoogleMark className="h-5 w-5 shrink-0 transition-transform duration-200 group-hover:scale-105" />
          Continue with Google
        </a>

        {(oauthError || error) && (
          <p className="mt-4 text-sm text-zone-red" role="alert">
            {error ?? oauthError}
          </p>
        )}

        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowEmail((v) => !v)}
            className="text-sm text-ink-muted underline-offset-4 transition-colors hover:text-ink-secondary hover:underline"
          >
            {showEmail ? "Hide email sign-in" : "Use email instead"}
          </button>

          {showEmail && (
            <form onSubmit={onSubmit} className="mt-4 space-y-4 animate-[fade-up_0.35s_ease-out]">
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm text-ink-secondary">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary placeholder:text-ink-muted"
                />
              </div>
              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm text-ink-secondary">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary placeholder:text-ink-muted"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-md bg-accent px-3 py-2 font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
        </div>

        <p className="mt-10 text-sm text-ink-muted">
          <Link
            to="/privacy"
            className="underline-offset-4 transition-colors hover:text-ink-secondary hover:underline"
          >
            Privacy policy
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
