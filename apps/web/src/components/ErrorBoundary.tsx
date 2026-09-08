import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Last resort for a render that throws. Without one, React 18 unmounts the whole root and
 * leaves an empty page on the dark background from index.html's critical CSS — a blank
 * screen with the reason visible only in a console the athlete doesn't have open.
 *
 * What it does NOT catch: event handlers, async callbacks, and anything thrown outside the
 * render phase — including a react-query option callback firing when data lands. Guarding
 * the data those callbacks read (see isEntitled in lib/auth.tsx) is the other half of this;
 * neither replaces the other.
 *
 * A class is required — React exposes no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No error-reporting service in this app — the console is the whole audience.
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0 px-6">
        <div className="w-full max-w-sm">
          <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far</p>
          <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight text-ink-primary">
            Something went wrong
          </h1>
          <p className="mb-8 text-sm leading-relaxed text-ink-secondary">
            The page didn&apos;t load properly. Reloading usually clears it — nothing you saved
            has been lost.
          </p>
          {/* window.location rather than the router: the failure may well be in the router or
              a provider above it, so the recovery path shouldn't depend on either. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-accent px-3 py-2 font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
