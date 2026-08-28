import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

interface OnboardingStatus {
  hasWhoop: boolean;
  hasLocation: boolean;
  hasPlan: boolean;
}

const DISMISS_KEY = "run-far:onboarding-dismissed";

/** Surfaces what's still unset for a brand-new user, so an empty dashboard reads as "not set
 * up yet" rather than a working app quietly reporting good recovery and no conflicts. */
export function OnboardingChecklist() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");

  const status = useQuery<OnboardingStatus>({
    queryKey: ["settings", "onboarding"],
    queryFn: () => api.get<OnboardingStatus>("/settings/onboarding"),
  });

  const data = status.data;
  const items = data
    ? [
        { done: data.hasWhoop, label: "Connect Whoop for recovery, sleep, and strain data", to: "/settings" },
        { done: data.hasLocation, label: "Set your location for weather-aware recommendations", to: "/settings" },
        { done: data.hasPlan, label: "Build or import a training plan", to: "/build" },
      ]
    : [];
  const incomplete = items.filter((i) => !i.done);

  if (dismissed || status.isLoading || incomplete.length === 0) return null;

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-sm font-semibold text-ink-primary">Finish setting up</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink-secondary">
            {incomplete.map((item) => (
              <li key={item.label}>
                <Link to={item.to} className="hover:text-ink-primary hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <button
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
          className="shrink-0 text-xs text-ink-muted hover:text-ink-secondary"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
