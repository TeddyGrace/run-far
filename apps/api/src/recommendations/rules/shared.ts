import { HARD_RUN_TYPES } from "../config.js";
import type { PlannedRunRow } from "../types.js";

/** The next scheduled run at or after "now" — the one a rule would consider modifying. */
export function nextRun(upcoming: PlannedRunRow[]): PlannedRunRow | null {
  const sorted = [...upcoming].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  return sorted[0] ?? null;
}

export function isHardRun(run: PlannedRunRow | null): boolean {
  if (!run) return false;
  return (HARD_RUN_TYPES as readonly string[]).includes(run.runType);
}
