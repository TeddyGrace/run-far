import { Link } from "react-router-dom";

const CONTACT_EMAIL = "theodore.g.grace@gmail.com";

export function Refund() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface-0 px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(79,176,166,0.18),transparent_55%),radial-gradient(ellipse_at_90%_100%,rgba(217,165,72,0.08),transparent_45%)]"
      />
      <div className="relative mx-auto max-w-2xl animate-[fade-up_0.5s_ease-out]">
        <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
          Refund policy
        </h1>
        <p className="mb-10 text-sm text-ink-muted">Last updated September 3, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-ink-secondary">
          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Free trial</h2>
            <p>
              New subscriptions start with a 14-day free trial. A payment method is required up front,
              but you&apos;re not charged anything until the trial ends. Cancel any time during the
              trial from Settings → Billing → Manage billing and you won&apos;t be charged at all.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Cancellation</h2>
            <p>
              Cancel any time from Settings → Billing → Manage billing. Cancelling stops future billing
              — you keep access through the end of the period you already paid for, and are not charged
              again after that.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">Refunds</h2>
            <p>
              Charges are generally non-refundable — cancelling stops future billing rather than
              refunding the current period. That said, this is a small, personally-operated app: if
              something went wrong on our end (a bug, a duplicate charge, being billed after you
              cancelled), email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-ink-primary underline-offset-4 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>{" "}
              and we&apos;ll make it right.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink-primary">
              Payment processing
            </h2>
            <p>
              All payments are handled by Stripe. run-far never sees or stores your card details — see
              the{" "}
              <Link to="/privacy" className="text-ink-primary underline-offset-4 hover:underline">
                privacy policy
              </Link>{" "}
              for details.
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
            to="/terms"
            className="text-ink-secondary underline-offset-4 transition-colors hover:text-ink-primary hover:underline"
          >
            Terms of service
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
