import type { BusyPeriod, PlannedRunRow, RuleContext, RuleOutput } from "./types.js";
import { overlaps } from "./rules/shared.js";

/**
 * A planned run as the engine saw it when it minted a card against it.
 *
 * The field list deliberately mirrors RUN_FIELD_READERS in changeStaleness.ts — that module
 * already defines which run fields the engine reasons about, and a snapshot that omitted one
 * would be missing exactly the input some rule based its proposal on. Keep the two in step.
 * `id` and `status` are extra: the id joins back to planned_runs, and status distinguishes a
 * card written against a live session from one written against a run already skipped.
 */
export interface TargetRunSnapshot {
  id: string;
  scheduledAt: string;
  runType: string;
  distanceM: number | null;
  durationMin: number | null;
  targetPaceSPerKm: number | null;
  plannedTss: number | null;
  status: string;
}

/** A calendar busy period that overlapped a target run — window only, never the event title. */
export interface ConflictWindow {
  start: string;
  end: string;
}

export interface TrainingContext {
  targetRuns: TargetRunSnapshot[];
  conflictWindows: ConflictWindow[];
}

function projectRun(run: PlannedRunRow): TargetRunSnapshot {
  return {
    id: run.id,
    scheduledAt: run.scheduledAt.toISOString(),
    runType: run.runType,
    distanceM: run.distanceM ?? null,
    durationMin: run.durationMin ?? null,
    targetPaceSPerKm: run.targetPaceSPerKm ?? null,
    plannedTss: run.plannedTss ?? null,
    status: run.status,
  };
}

function busyWindowsFor(run: PlannedRunRow, busyPeriods: BusyPeriod[]): BusyPeriod[] {
  const runStart = run.scheduledAt;
  // Mirrors calendarConflict's own default: a run with no duration is treated as 30 minutes,
  // so the window recorded here is the window that rule tested against.
  const runEnd = new Date(runStart.getTime() + (run.durationMin ?? 30) * 60_000);
  return busyPeriods.filter((b) => overlaps(runStart, runEnd, b));
}

/**
 * Builds the persisted decision context for one card: the runs it proposes changing, and the
 * calendar windows conflicting with them.
 *
 * Why this exists: `proposedChanges` records a `plannedRunId` and a field delta, which says what
 * the engine wanted changed but nothing about what was being changed — a 20-mile long run and a
 * 3-mile shakeout are indistinguishable after the fact. Busy periods are worse: they are fetched
 * live from Google for one scheduling decision and persisted nowhere, so the input that motivated
 * a calendar-conflict card is gone the instant the request ends. (Weather needs no equivalent —
 * weather_forecasts is keyed (userId, date) and joins back retroactively.)
 *
 * Event titles are deliberately not captured. BusyPeriod.summary carries the athlete's calendar
 * event names — personal data from a third-party account, pulled in for a transient scheduling
 * decision. Copying it into a long-lived training table changes both what that data is for and
 * how long it lives. The overlap window is the part a model can learn from; the title is not.
 *
 * Pure, like the rules themselves: unit-testable against fixtures with no database.
 */
export function buildTrainingContext(
  card: Pick<RuleOutput, "proposedChanges">,
  ctx: Pick<RuleContext, "upcoming" | "busyPeriods">,
): TrainingContext {
  // Advisory cards propose nothing, so they target no run and by extension conflict with
  // nothing — both arrays come back empty rather than the column being half-populated.
  const runIds = [...new Set((card.proposedChanges ?? []).map((c) => c.plannedRunId))];
  if (runIds.length === 0) return { targetRuns: [], conflictWindows: [] };

  const byId = new Map(ctx.upcoming.map((r) => [r.id, r]));
  // A proposed change can name a run outside `upcoming` (one that has since moved out of the
  // lookahead window, say). Nothing can be recorded about a run the engine didn't hold, so it
  // is skipped rather than written as a placeholder that would read as real data later.
  const targets = runIds.map((id) => byId.get(id)).filter((r): r is PlannedRunRow => Boolean(r));

  // Dedupe by window: two target runs conflicting with the same meeting is one busy period,
  // and the same event fetched per-run would otherwise be recorded twice.
  const windows = new Map<string, ConflictWindow>();
  for (const run of targets) {
    for (const busy of busyWindowsFor(run, ctx.busyPeriods ?? [])) {
      const start = busy.start.toISOString();
      const end = busy.end.toISOString();
      windows.set(`${start}/${end}`, { start, end });
    }
  }

  return {
    targetRuns: targets.map(projectRun),
    conflictWindows: [...windows.values()].sort((a, b) => a.start.localeCompare(b.start)),
  };
}
