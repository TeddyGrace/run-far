import { Link } from "react-router-dom";

const CONTACT_EMAIL = "theodore.g.grace@gmail.com";

export function Terms() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-0 px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative mx-auto max-w-2xl animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Terms of service
        </h1>
        <p className="mb-10 text-sm text-ink-muted">Last updated September 3, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-ink-secondary">
          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">The short version</h2>
            <p>
              run-far is a subscription training dashboard, built and operated by a single developer,
              not a company. By creating an account you agree to these terms. If you don&apos;t agree,
              don&apos;t use run-far.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Your account</h2>
            <p>
              You&apos;re responsible for the accuracy of the information you provide and for keeping
              your login secure. You must be able to enter a valid legal agreement to use run-far (in
              most places, this means being at least 18, or the age of majority where you live).
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Subscriptions and billing
            </h2>
            <ul className="list-disc space-y-3 pl-5">
              <li>
                Paid access is billed through Stripe on a recurring monthly or annual basis. A new
                subscription may start with a free trial that still requires a payment method — you
                won&apos;t be charged until the trial ends, and you can cancel any time before then.
              </li>
              <li>
                Your subscription renews automatically at the then-current price until you cancel.
                Cancel any time from Settings → Billing → Manage billing; access continues through the
                end of the period you already paid for.
              </li>
              <li>
                See the{" "}
                <Link to="/refunds" className="text-ink-primary underline-offset-4 hover:underline">
                  refund policy
                </Link>{" "}
                for how refunds are handled.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              What run-far does and doesn&apos;t do
            </h2>
            <p>
              run-far surfaces recovery data and training suggestions to help you plan your own
              training. It is not a medical device, does not provide medical advice, and its
              recommendations are not a substitute for guidance from a coach or physician. Use your own
              judgment, especially around injury, illness, or pain — when in doubt, rest and check with
              a professional.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Acceptable use</h2>
            <p>
              Don&apos;t try to break, abuse, or overload the service (including running excessive
              automated requests against the AI features), impersonate someone else, or use run-far for
              anything illegal.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Suspension and termination
            </h2>
            <p>
              You can close your own account at any time from Settings → Danger zone, which also
              cancels any active subscription. We may suspend or disable an account that violates these
              terms or abuses the service.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Service &quot;as is&quot;
            </h2>
            <p>
              run-far is provided as-is, without warranties of any kind. It depends on third-party
              services (Whoop, Google, Anthropic, Stripe) that can change or become unavailable —
              we&apos;re not liable for outages or data loss caused by those providers. To the extent
              the law allows, our liability to you is limited to the amount you paid in the three months
              before a claim.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Changes</h2>
            <p>
              These terms may change as the app does. Material changes will be reflected here with an
              updated date; continuing to use run-far after a change means you accept the update.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Contact</h2>
            <p>
              Questions about these terms? Email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-ink-primary underline-offset-4 hover:underline"
              >
                {CONTACT_EMAIL}
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
            to="/privacy"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Privacy policy
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
