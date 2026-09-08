import { HARD_RUN_TYPES } from "../config.js";
import type { BusyPeriod, PlannedRunRow } from "../types.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";

/** Half-open interval overlap: touching endpoints (a run ending exactly when a meeting starts)
 * don't count as a conflict. Shared by calendarConflict, which decides whether to fire, and by
 * trainingContext, which records which busy windows motivated the card it fired — the two must
 * agree on what "overlaps" means or the record won't match the decision. */
export function overlaps(runStart: Date, runEnd: Date, busy: BusyPeriod): boolean {
  return runStart < busy.end && runEnd > busy.start;
}

/** Every upcoming run on `localDate` (the athlete's local calendar date), earliest first. */
export function runsOnLocalDate(
  upcoming: PlannedRunRow[],
  localDate: string,
  timeZone: string,
): PlannedRunRow[] {
  return [...upcoming]
    .filter((r) => dateYmdInZone(r.scheduledAt, timeZone) === localDate)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

/**
 * The next run still to come *today*, in the athlete's own timezone — the run a
 * recovery-driven rule may modify.
 *
 * Recovery score, sleep debt and HRV suppression are all statements about today. Reaching
 * past today (which the old `nextRun` did — it took the earliest run anywhere in the 10-day
 * lookahead) meant a rest day today would let this morning's recovery score downgrade a
 * session three days out. When today has no run left, these rules simply don't fire.
 */
export function todaysRun(upcoming: PlannedRunRow[], timeZone: string, now: Date): PlannedRunRow | null {
  const today = dateYmdInZone(now, timeZone);
  return runsOnLocalDate(upcoming, today, timeZone)[0] ?? null;
}

export function isHardRun(run: PlannedRunRow | null): boolean {
  if (!run) return false;
  return (HARD_RUN_TYPES as readonly string[]).includes(run.runType);
}
