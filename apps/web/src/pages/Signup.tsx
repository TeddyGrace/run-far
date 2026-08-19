import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";

export function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    if (password.length < 10) {
      setError("Password must be at least 10 characters");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/auth/signup", { email, password });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong creating your account");
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
          Create an account
        </h1>

        {sent ? (
          <>
            <p className="mb-1 text-sm leading-relaxed text-ink-secondary">
              Check <span className="font-medium text-ink-primary">{email}</span> for a verification
              link.
            </p>
            <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
              Once verified, an admin will approve access before you can sign in.
            </p>
          </>
        ) : (
          <>
            <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
              Sign up with an email and password. You'll verify your email, then an admin
              approves access before you can sign in.
            </p>
            <form onSubmit={onSubmit} className="space-y-4">
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
                  minLength={10}
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
                {submitting ? "Creating account…" : "Create account"}
              </button>
            </form>
          </>
        )}

        <p className="mt-10 text-sm text-ink-muted">
          Already have an account?{" "}
          <Link
            to="/login"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Sign in
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
