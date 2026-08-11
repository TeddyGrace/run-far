import type { Recommendation } from "@run-far/shared";
import { ZONE_HEX, type Zone } from "../lib/zone.js";

const SEVERITY_ZONE: Record<Recommendation["severity"], Zone> = {
  red: "red",
  yellow: "yellow",
  info: "info",
};

interface RecommendationCardProps {
  recommendation: Recommendation;
  primary: boolean;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  pending: boolean;
}

export function RecommendationCard({ recommendation, primary, onAccept, onDismiss, pending }: RecommendationCardProps) {
  const hex = ZONE_HEX[SEVERITY_ZONE[recommendation.severity]];

  return (
    <div
      className="rounded-xl border border-border bg-surface-1 p-5"
      style={{ borderLeft: `3px solid ${hex}` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className={primary ? "font-display text-lg font-semibold text-ink-primary" : "font-medium text-ink-primary"}>
            {recommendation.summary}
          </p>
          <p className="mt-1.5 text-sm text-ink-secondary">{recommendation.reason}</p>
        </div>
      </div>
      {recommendation.proposedChanges.length > 0 && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => onAccept(recommendation.id)}
            disabled={pending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Accept
          </button>
          <button
            onClick={() => onDismiss(recommendation.id)}
            disabled={pending}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:text-ink-primary disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}
      {recommendation.proposedChanges.length === 0 && (
        <button
          onClick={() => onDismiss(recommendation.id)}
          disabled={pending}
          className="mt-4 text-sm text-ink-muted transition-colors hover:text-ink-secondary disabled:opacity-50"
        >
          Got it, dismiss
        </button>
      )}
    </div>
  );
}
