import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api.js";
import type { CurrentUser } from "../lib/auth.js";

/** How long the "Email verified" confirmation stays up before we move on by ourselves. Long
 * enough to read, short enough that nobody wonders whether the page is stuck. */
const REDIRECT_DELAY_MS = 1200;

export function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "ok" | "error">(token ? "loading" : "error");
  const [message, setMessage] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;

    async function verify() {
      try {
        // The response here is a bare { id, email } — not the CurrentUser shape the rest of
        // the app reads (entitlement, role, flags). Seeding ["auth", "me"] with it would hand
        // every consumer a user object with no `entitlement`, so we throw the response away
        // and let /api/auth/me supply the real shape below.
        await api.post("/auth/verify-email", { token });
      } catch (err) {
        // Verification tokens are single-use, so a refresh or a second click on the emailed
        // link lands here even though the account is now verified and the session cookie the
        // first click set is still live. Ask who we are before calling the link broken. (A
        // genuinely bad token clicked by someone already signed in also passes — sending them
        // to their own dashboard beats a false "Link invalid".)
        const alreadyVerified = await api
          .get<CurrentUser>("/auth/me")
          .then((me) => me.emailVerified)
          .catch(() => false);
        if (!alreadyVerified) {
          setMessage(err instanceof ApiError ? err.message : "Something went wrong verifying your email");
          setStatus("error");
          return;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      setStatus("ok");
    }

    void verify();
  }, [token, queryClient]);

  // The success copy promises a redirect, so actually perform one. `replace` keeps the spent
  // token out of history — going Back would otherwise return to a link that can't work twice.
  useEffect(() => {
    if (status !== "ok") return;
    const timer = setTimeout(() => navigate("/", { replace: true }), REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status, navigate]);

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
              replace
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
