import clsx from "clsx";
import type { ReactNode } from "react";

export type BadgeTone = "good" | "muted" | "yellow" | "red";

const TONES: Record<BadgeTone, string> = {
  good: "bg-zone-good/15 text-zone-good",
  muted: "bg-surface-2 text-ink-muted",
  yellow: "bg-zone-yellow/15 text-zone-yellow",
  red: "bg-zone-red/15 text-zone-red",
};

/** A state pill. Used in the collapsed row so connection state reads without expanding. */
export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
