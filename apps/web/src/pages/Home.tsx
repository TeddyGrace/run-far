import { Link } from "react-router-dom";

const CONTACT_EMAIL = "theodore.g.grace@gmail.com";

const FEATURES = [
  {
    title: "Daily readiness",
    body: "Each morning run-far reads your Whoop recovery, HRV, sleep, and strain and turns them into one clear call: run hard, run easy, or rest.",
  },
  {
    title: "Training plans",
    body: "Build a running plan week by week — long runs, workouts, and easy days — with an AI plan builder that adapts the schedule to how you're actually recovering.",
  },
  {
    title: "Calendar sync",
    body: "Planned runs are written to a dedicated \"Running\" calendar on your Google account, so today's session shows up next to the rest of your day.",
  },
];

const GOOGLE_USES = [
  {
    scope: "Google Calendar",
    body: "run-far creates a separate \"Running\" calendar and writes your planned runs to it. It reads your primary calendar only to flag conflicts with a planned run, and never writes to any calendar it didn't create.",
  },
  {
    scope: "Gmail (send only)",
    body: "run-far can email your recovery digest to you from your own account. It never reads, lists, or downloads your existing mail.",
  },
  {
    scope: "Google sign-in",
    body: "Your name and email address identify your run-far account. Nothing else from your Google profile is collected.",
  },
];

export function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-0 px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />

      <div className="relative mx-auto max-w-2xl animate-[fade-up_0.5s_ease-out]">
        <header>
          <p className="mb-3 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
          <h1 className="mb-4 font-display text-4xl font-semibold tracking-tight text-ink-primary">
            run-far
          </h1>
          <p className="text-base leading-relaxed text-ink-secondary">
            run-far is a personal training dashboard for runners. It tracks how recovered you are
            each day, helps you build a running plan around that, and keeps the plan on your Google
            Calendar — so the run you do today matches the shape you&apos;re actually in.
          </p>
        </header>

        <section className="mt-12">
          <h2 className="mb-5 font-display text-lg font-semibold text-ink-primary">
            What run-far does
          </h2>
          <div className="space-y-5">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-border bg-surface-1 px-5 py-4"
              >
                <h3 className="mb-1.5 font-display text-base font-semibold text-ink-primary">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-ink-secondary">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="mb-5 font-display text-lg font-semibold text-ink-primary">Pricing</h2>
          <div className="flex flex-wrap gap-4">
            <div className="rounded-lg border border-border bg-surface-1 px-5 py-4">
              <p className="text-xs font-medium text-ink-secondary">Monthly</p>
              <p className="font-display text-2xl font-semibold text-ink-primary">
                $6.99<span className="text-sm font-normal text-ink-muted">/mo</span>
              </p>
            </div>
            <div className="rounded-lg border border-border bg-surface-1 px-5 py-4">
              <p className="text-xs font-medium text-ink-secondary">Annual</p>
              <p className="font-display text-2xl font-semibold text-ink-primary">
                $59.99<span className="text-sm font-normal text-ink-muted">/yr</span>
              </p>
              <p className="mt-0.5 text-xs text-accent">save ~29%</p>
            </div>
          </div>
          <p className="mt-3 text-sm text-ink-secondary">
            Every plan starts with a 14-day free trial — a card is required, but you&apos;re not
            charged until the trial ends.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="mb-3 font-display text-lg font-semibold text-ink-primary">
            How run-far uses your Google account
          </h2>
          <p className="mb-5 text-sm leading-relaxed text-ink-secondary">
            run-far asks for Google access only for the features below, and uses that access for
            nothing else. You can revoke it at any time from{" "}
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
              className="text-ink-primary underline-offset-4 hover:underline"
            >
              Google Account permissions
            </a>
            .
          </p>
          <dl className="space-y-5 text-sm leading-relaxed">
            {GOOGLE_USES.map((use) => (
              <div key={use.scope}>
                <dt className="mb-1 font-medium text-ink-primary">{use.scope}</dt>
                <dd className="text-ink-secondary">{use.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="mt-12 flex flex-wrap items-center gap-4">
          <Link
            to="/login"
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            Sign in to run-far
          </Link>
          <Link
            to="/privacy"
            className="text-sm text-ink-muted underline-offset-4 transition-colors hover:text-ink-secondary hover:underline"
          >
            Privacy policy
          </Link>
          <Link
            to="/terms"
            className="text-sm text-ink-muted underline-offset-4 transition-colors hover:text-ink-secondary hover:underline"
          >
            Terms
          </Link>
          <Link
            to="/refunds"
            className="text-sm text-ink-muted underline-offset-4 transition-colors hover:text-ink-secondary hover:underline"
          >
            Refunds
          </Link>
        </div>

        <footer className="mt-16 border-t border-border pt-6 text-xs text-ink-muted">
          <p>
            run-far · a personal running dashboard by Teddy Grace ·{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="underline-offset-4 hover:text-ink-secondary hover:underline"
            >
              {CONTACT_EMAIL}
            </a>
          </p>
        </footer>
      </div>

      <style>{`
        /* Deliberately no opacity ramp: this page is what Google's OAuth branding verifier
           reads, and a headless renderer that screenshots within the first 500ms would
           otherwise capture the copy mid-fade and score the page as empty. Slide only. */
        @keyframes fade-up {
          from { transform: translateY(10px); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
