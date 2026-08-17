import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";

const CONTACT_EMAIL = "theodore.g.grace@gmail.com";

export function AccessRequested() {
  const [searchParams] = useSearchParams();
  const email = searchParams.get("email");

  const mailtoHref = useMemo(() => {
    const subject = "run-far access request";
    const body = email
      ? `Hi Teddy,\n\nCould you add my Google account to run-far's allowlist?\n\n${email}\n`
      : "Hi Teddy,\n\nCould you add my Google account to run-far's allowlist?\n";
    return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }, [email]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-0 px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative w-full max-w-sm animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Invite only
        </h1>
        <p className="mb-1 text-sm leading-relaxed text-ink-secondary">
          run-far is currently invite-only, and{" "}
          {email ? <span className="font-medium text-ink-primary">{email}</span> : "your account"}{" "}
          isn&apos;t on the list yet.
        </p>
        <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
          Send a quick request and I&apos;ll add you.
        </p>

        <a
          href={mailtoHref}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2.5 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 active:scale-[0.99]"
        >
          Request access
        </a>

        <p className="mt-6 text-sm text-ink-muted">
          Already invited?{" "}
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
