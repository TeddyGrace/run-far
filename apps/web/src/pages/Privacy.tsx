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
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Privacy policy
        </h1>
        <p className="mb-10 text-sm text-ink-muted">Last updated September 3, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-ink-secondary">
          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">What run-far is</h2>
            <p>
              run-far is a personal training dashboard for running — recovery tracking, plan building,
              and calendar sync, available by subscription. It&apos;s built and operated by a single
              developer, not a company.
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
              <li>
                <span className="font-medium text-ink-primary">Stripe (payments).</span> If you
                subscribe, Stripe processes and stores your payment details — we never see or store
                your card number. We keep your subscription status and Stripe&apos;s customer and
                subscription identifiers so the app knows what you&apos;re entitled to.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              How we protect your data
            </h2>
            <p className="mb-3">
              We treat your Google Calendar data, Gmail access, and Whoop health metrics as sensitive
              and apply the following safeguards to protect them:
            </p>
            <ul className="list-disc space-y-3 pl-5">
              <li>
                <span className="font-medium text-ink-primary">Encryption in transit.</span> All
                traffic between your device, run-far, and every third-party provider (Google, Whoop,
                Anthropic) is encrypted using HTTPS/TLS.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Encryption at rest.</span> OAuth access
                and refresh tokens for Google and Whoop are encrypted before storage using AES-256-GCM
                authenticated encryption. Plaintext tokens are never written to the database.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Password protection.</span> If you set a
                password, it is hashed with argon2id and never stored in plain text. We cannot recover
                or view your password.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Least-privilege access.</span> We
                request the narrowest Google scopes needed (send-only Gmail, and calendar access
                limited to the dedicated Running calendar plus read access for conflict detection).
                Encryption keys are held as server-side secrets, separate from the stored data.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Restricted infrastructure.</span> Data
                is hosted on Railway, and access to the production database and secrets is limited to
                the single developer who operates run-far.
              </li>
              <li>
                <span className="font-medium text-ink-primary">Retention and deletion.</span> Your data
                is kept only while your account is active. When you revoke access or request deletion,
                the associated tokens and data are removed. You can revoke run-far&apos;s access to your
                Google account at any time (see below).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Data sharing</h2>
            <p>
              We don&apos;t sell or share your data. It&apos;s only sent to the service providers
              listed above (Google, Whoop, Anthropic, Stripe), and only as needed to provide the
              app&apos;s features.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Limited Use of Google user data
            </h2>
            <p className="mb-3">
              run-far&apos;s use and transfer of information received from Google APIs adheres to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noreferrer"
                className="text-ink-primary underline-offset-4 hover:underline"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
            <p>
              In particular, raw or derived data received from Google Workspace APIs is never used,
              transferred, or sold to develop, improve, or train foundational or generalized machine
              learning or artificial intelligence models. Any AI features (the plan builder and
              assistant chat) operate only on your training schedule to generate responses for you, and
              our AI provider (Anthropic) does not train its models on data sent through its API.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Access, deletion, and contact
            </h2>
            <p>
              You can export your data and delete your account yourself at any time from Settings →
              Danger zone — deleting your account also cancels any subscription and revokes run-far&apos;s
              Google and Whoop access. For anything else — a question, a request for your data, or help
              with an account — email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-ink-primary underline-offset-4 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              . You can also revoke run-far&apos;s access to your Google account directly from{" "}
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

        <p className="mt-10 flex gap-4 text-sm">
          <Link
            to="/login"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Back to sign in
          </Link>
          <Link
            to="/terms"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Terms of service
          </Link>
          <Link
            to="/refunds"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Refund policy
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
