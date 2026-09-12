import type { AdherenceResponse, ActualWorkout, ReconciledRun, RunType } from "@run-far/shared";
import { isRunSport } from "@run-far/shared";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { plannedRuns, workouts } from "../db/schema.js";
import { getAthleteTimezone } from "../lib/athleteTimezone.js";
import { getActiveHealthProvider, providerFilter } from "../lib/healthProvider.js";
import { addLocalDays, dateYmdInZone, zonedLocalToIso } from "../lib/zonedTime.js";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";

/** Rest days are excluded from every adherence figure: there is nothing to execute, so counting
 * them would inflate the denominator with sessions that can never be completed. Mirrors the
 * matcher's own exclusion — keep the two in step. */
const NON_EXECUTABLE_RUN_TYPES = new Set<string>(["rest"]);

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The planned-vs-actual readout for a recent window.
 *
 * A pure read: it reports what the reconciliation sweep decided and never decides anything
 * itself, so the numbers on the dashboard and the rows a future model trains on are the same
 * rows, not two parallel derivations that can disagree.
 */
export async function buildAdherence(
  userId: string,
  opts: { windowDays: number; now?: Date },
): Promise<AdherenceResponse> {
  const now = opts.now ?? new Date();
  const timeZone = await getAthleteTimezone(userId);
  // Same provider scope as the sweep that produced these matches (reconciliation/service.ts):
  // the unmatched-workout list below is "runs we saw that the plan didn't ask for", and an
  // inactive provider's duplicate of an already-matched run would show up as exactly that.
  const provider = await getActiveHealthProvider(userId);

  const todayYmd = dateYmdInZone(now, timeZone);
  const fromYmd = dateYmdInZone(addLocalDays(now, -(opts.windowDays - 1), timeZone), timeZone);
  const tomorrowYmd = dateYmdInZone(addLocalDays(now, 1, timeZone), timeZone);
  const fromInstant = new Date(zonedLocalToIso(fromYmd, "00:00", timeZone));
  const toInstant = new Date(zonedLocalToIso(tomorrowYmd, "00:00", timeZone));

  const activePlanId = await getActivePlanId(userId);
  const rows = await db
    .select({
      id: plannedRuns.id,
      scheduledAt: plannedRuns.scheduledAt,
      runType: plannedRuns.runType,
      status: plannedRuns.status,
      plannedDistanceM: plannedRuns.distanceM,
      plannedDurationMin: plannedRuns.durationMin,
      matchSource: plannedRuns.matchSource,
      reconciledAt: plannedRuns.reconciledAt,
      workoutId: workouts.id,
      workoutDate: workouts.date,
      workoutStartedAt: workouts.startedAt,
      workoutSport: workouts.sport,
      workoutDurationMin: workouts.durationMin,
      workoutDistanceM: workouts.distanceM,
      workoutStrain: workouts.strain,
      workoutAvgHr: workouts.avgHr,
    })
    .from(plannedRuns)
    .leftJoin(workouts, eq(plannedRuns.actualWorkoutId, workouts.id))
    .where(
      and(
        visibleRunsSql(userId, activePlanId),
        gte(plannedRuns.scheduledAt, fromInstant),
        lt(plannedRuns.scheduledAt, toInstant),
      ),
    )
    .orderBy(asc(plannedRuns.scheduledAt));

  const executable = rows.filter((r) => !NON_EXECUTABLE_RUN_TYPES.has(r.runType));

  const runs: ReconciledRun[] = executable.map((r) => {
    const actual: ActualWorkout | null = r.workoutId
      ? {
          id: r.workoutId,
          date: r.workoutDate!,
          startedAt: r.workoutStartedAt?.toISOString() ?? null,
          sport: r.workoutSport,
          durationMin: r.workoutDurationMin,
          distanceM: r.workoutDistanceM,
          strain: r.workoutStrain,
          avgHr: r.workoutAvgHr,
        }
      : null;
    return {
      plannedRunId: r.id,
      scheduledAt: r.scheduledAt.toISOString(),
      runType: r.runType as RunType,
      status: r.status,
      plannedDistanceM: r.plannedDistanceM,
      plannedDurationMin: r.plannedDurationMin,
      matchSource: r.matchSource,
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
      actual,
      distanceDeltaM:
        actual?.distanceM != null && r.plannedDistanceM != null
          ? round(actual.distanceM - r.plannedDistanceM)
          : null,
      durationDeltaMin:
        actual?.durationMin != null && r.plannedDurationMin != null
          ? round(actual.durationMin - r.plannedDurationMin)
          : null,
    };
  });

  const completed = runs.filter((r) => r.status === "completed");
  const skipped = runs.filter((r) => r.status === "skipped");
  const settled = completed.length + skipped.length;

  // Of the unsettled runs, the ones whose day is over are unsettled for a different reason than
  // the ones still ahead: the sweep looked and could not tell (see workoutCoverageThrough in
  // service.ts). Reporting them together as "open" is what let an athlete with no wearable be
  // shown 0% adherence.
  const unsettled = runs.filter((r) => r.status !== "completed" && r.status !== "skipped");
  const untracked = unsettled.filter(
    (r) => dateYmdInZone(new Date(r.scheduledAt), timeZone) < todayYmd,
  );

  const byRunType = new Map<RunType, { completed: number; skipped: number }>();
  for (const r of runs) {
    if (r.status !== "completed" && r.status !== "skipped") continue;
    const entry = byRunType.get(r.runType) ?? { completed: 0, skipped: 0 };
    if (r.status === "completed") entry.completed += 1;
    else entry.skipped += 1;
    byRunType.set(r.runType, entry);
  }

  // Planned volume counts every executable run in the window, done or not — that is the point
  // of the comparison. Actual volume counts only what a matched workout actually recorded, so
  // an unmatched run contributes to the plan side and nothing to the actual side.
  const sum = (ns: Array<number | null | undefined>) =>
    round(ns.reduce<number>((acc, n) => acc + (n ?? 0), 0));

  const matchedWorkoutIds = new Set(runs.map((r) => r.actual?.id).filter(Boolean));
  const workoutRows = await db
    .select()
    .from(workouts)
    .where(
      and(
        providerFilter.workouts(userId, provider),
        gte(workouts.date, fromYmd),
        sql`${workouts.date} <= ${todayYmd}`,
      ),
    )
    .orderBy(asc(workouts.date));

  const unmatchedWorkouts: ActualWorkout[] = workoutRows
    .filter((w) => isRunSport(w.sport) && !matchedWorkoutIds.has(w.id))
    .map((w) => ({
      id: w.id,
      date: w.date,
      startedAt: w.startedAt?.toISOString() ?? null,
      sport: w.sport,
      durationMin: w.durationMin,
      distanceM: w.distanceM,
      strain: w.strain,
      avgHr: w.avgHr,
    }));

  return {
    summary: {
      from: fromYmd,
      to: todayYmd,
      windowDays: opts.windowDays,
      counts: {
        total: runs.length,
        completed: completed.length,
        skipped: skipped.length,
        upcoming: unsettled.length - untracked.length,
        untracked: untracked.length,
      },
      completionRate: settled === 0 ? null : completed.length / settled,
      plannedDistanceM: sum(runs.map((r) => r.plannedDistanceM)),
      actualDistanceM: sum(runs.map((r) => r.actual?.distanceM)),
      plannedDurationMin: sum(runs.map((r) => r.plannedDurationMin)),
      actualDurationMin: sum(runs.map((r) => r.actual?.durationMin)),
      byRunType: [...byRunType.entries()]
        .map(([runType, v]) => ({ runType, ...v }))
        .sort((a, b) => a.runType.localeCompare(b.runType)),
    },
    runs,
    unmatchedWorkouts,
  };
}
