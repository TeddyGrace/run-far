import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MIN_PASSWORD_LENGTH } from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";

interface TokenCheck {
  valid: boolean;
  email?: string;
  hasPassword?: boolean;
}

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Checked on arrival rather than on submit: an expired or already-used link is the common
  // case an hour after the email lands, and finding that out only after choosing and typing
  // a password twice is a dead end. This peeks at the token without spending it.
  const check = useQuery<TokenCheck>({
    queryKey: ["auth", "reset-token", token],
    queryFn: () => api.post<TokenCheck>("/auth/reset-password/check", { token }),
    enabled: token != null,
    retry: false,
    staleTime: Infinity,
  });

  const submit = useMutation({
    mutationFn: () => api.post("/auth/reset-password", { token, password }),
    onSuccess: (user) => {
      queryClient.setQueryData(["auth", "me"], user);
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      navigate("/", { replace: true });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    submit.mutate();
  }

  const linkDead = token == null || (check.isSuccess && !check.data.valid) || check.isError;
  const account = check.data?.valid ? check.data : null;
  const submitError = submit.isError
    ? submit.error instanceof ApiError
      ? submit.error.message
      : "Something went wrong resetting your password"
    : null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-0 px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative w-full max-w-sm animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          {account && !account.hasPassword ? "Choose a password" : "Choose a new password"}
        </h1>

        {linkDead ? (
          <p className="mb-8 text-sm leading-relaxed text-zone-red">
            This reset link has expired or has already been used.{" "}
            <Link to="/forgot-password" className="underline-offset-4 hover:underline">
              Request a new one
            </Link>
            .
          </p>
        ) : check.isPending ? (
          <p className="mb-8 text-sm leading-relaxed text-ink-secondary">Checking your link…</p>
        ) : (
          <>
            <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
              For <span className="font-medium text-ink-primary">{account?.email}</span>.
              {account && !account.hasPassword && (
                <>
                  {" "}
                  This account signs in with Google and doesn't have a password yet — setting one
                  lets you sign in either way.
                </>
              )}
            </p>
            <form onSubmit={onSubmit} className="space-y-4">
              {/* Tells a password manager which login it's saving. */}
              <input
                type="email"
                name="email"
                autoComplete="username"
                value={account?.email ?? ""}
                readOnly
                hidden
              />
              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm text-ink-secondary">
                  {account?.hasPassword ? "New password" : "Password"}
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary placeholder:text-ink-muted"
                />
                <p className="mt-1 text-xs text-ink-muted">
                  At least {MIN_PASSWORD_LENGTH} characters.
                </p>
              </div>
              <div>
                <label htmlFor="confirm" className="mb-1.5 block text-sm text-ink-secondary">
                  Confirm password
                </label>
                <input
                  id="confirm"
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary placeholder:text-ink-muted"
                />
              </div>
              {(error ?? submitError) && (
                <p className="text-sm text-zone-red" role="alert">
                  {error ?? submitError}
                </p>
              )}
              <button
                type="submit"
                disabled={submit.isPending}
                className="w-full rounded-md bg-accent px-3 py-2 font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submit.isPending ? "Saving…" : "Save password"}
              </button>
            </form>
          </>
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
