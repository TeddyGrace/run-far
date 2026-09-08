import type { ProposedChange } from "@run-far/shared";
import type { PlannedRunRow } from "./types.js";

/** Reads the field a ProposedChange refers to off a planned run — the mirror of
 * RUN_FIELD_APPLIERS, used to check the run still looks the way the rule saw it. */
const RUN_FIELD_READERS: Record<string, (run: PlannedRunRow) => unknown> = {
  runType: (r) => r.runType,
  targetPaceSPerKm: (r) => r.targetPaceSPerKm,
  durationMin: (r) => r.durationMin,
  distanceM: (r) => r.distanceM,
  scheduledAt: (r) => r.scheduledAt,
};

/**
 * True when the run no longer holds the value the rule based its proposal on — meaning the
 * athlete (or a sync) changed it after the card was generated.
 *
 * Applying `to` unconditionally, as this used to, silently reverted those edits: drag a run
 * to a new time in the calendar, accept a card minted before the drag, and the drag was gone.
 * A missing run counts as stale; an unknown field is left to the applier to reject.
 */
export function isChangeStale(run: PlannedRunRow | undefined, change: ProposedChange): boolean {
  if (!run) return true;
  const read = RUN_FIELD_READERS[change.field];
  if (!read) return false;
  const current = read(run);
  if (current instanceof Date) {
    const from = change.from == null ? null : new Date(change.from as string);
    return from == null || Number.isNaN(from.getTime()) || from.getTime() !== current.getTime();
  }
  return (current ?? null) !== (change.from ?? null);
}
