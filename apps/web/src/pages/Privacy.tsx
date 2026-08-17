import { Link } from "react-router-dom";

const CONTACT_EMAIL = "theodore.g.grace@gmail.com";

export function Privacy() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-0 px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative mx-auto max-w-2xl animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Privacy policy
        </h1>
        <p className="mb-10 text-sm text-ink-muted">Last updated August 17, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-ink-secondary">
          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">What run-far is</h2>
            <p>
              run-far is a personal, invite-only training dashboard for running — recovery tracking,
              plan building, and calendar sync. It&apos;s built and operated by a single developer, not
              a company, and access is limited to people who&apos;ve been individually invited.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Data we collect and why
            </h2>
            <ul className="list-disc space-y-3 pl-5">
              <li>
                <span className="font-medium text-ink-primary">Google Calendar.</span> We create and
                sync a dedicated &quot;Running&quot; calendar on your Google account, and read your
                primary calendar to detect scheduling conflicts with planned runs. We only ever write
                to the Running calendar we create.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Gmail — send only.</span> We use the
                Gmail send-only scope to email you things like your recovery digest, sent as your own
                account. We never read, list, or access your existing mail.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Google sign-in.</span> We use your
                Google account&apos;s name and email to identify your account. Nothing else from your
                Google profile is collected.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Whoop.</span> If you connect Whoop, we
                pull recovery, HRV, sleep, and strain data to inform training recommendations.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Anthropic (Claude AI).</span> When you
                use the AI plan builder or assistant chat, relevant parts of your training schedule are
                sent to Anthropic&apos;s API to generate responses.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Account data.</span> Email address, a
                hashed password (if you set one), and timezone.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">How data is stored</h2>
            <p>
              Data is hosted on Railway. OAuth tokens (Google, Whoop) are encrypted at rest. Passwords
              are hashed, never stored in plain text.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Data sharing</h2>
            <p>
              We don&apos;t sell or share your data. It&apos;s only sent to the service providers
              listed above (Google, Whoop, Anthropic), and only as needed to provide the app&apos;s
              features.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Access, deletion, and contact
            </h2>
            <p>
              To ask a question, request your data, revoke access, or delete your account, email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-ink-primary underline-offset-4 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              . You can also revoke run-far&apos;s access to your Google account at any time from{" "}
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
          </section>
        </div>

        <p className="mt-10 text-sm">
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
