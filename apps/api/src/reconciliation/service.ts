import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { plannedRuns, syncState, whoopWorkouts } from "../db/schema.js";
import { getAthleteTimezone } from "../lib/athleteTimezone.js";
import { logger } from "../lib/logger.js";
import { addLocalDays, dateYmdInZone, zonedLocalToIso } from "../lib/zonedTime.js";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";
import { matchWorkoutsToRuns, type MatchableRun, type MatchableWorkout } from "./match.js";
import { recordSettledOutcomes } from "./outcome.js";

/**
 * How far back a sweep reconsiders. Long enough that a late Whoop sync, a dropped webhook, or
 * a few days offline still get picked up; short enough that the pass stays a handful of rows.
 * Anything older is already settled and re-deciding it would only risk unsettling it.
 */
const DEFAULT_WINDOW_DAYS = 21;

export interface ReconcileResult {
  completed: number;
  skipped: number;
  reopened: number;
  /** Past runs the sweep deliberately reached no verdict on, because it had no way to observe
   * whether they happened. Reported so a caller can tell "nothing was missed" from "we couldn't
   * see". */
  untracked: number;
}

/**
 * The instant through which we can trust an absence of workouts to mean an absence of running.
 *
 * Null when Whoop has never synced for this athlete. Absence of evidence is not evidence of
 * absence: without this gate, an athlete with a plan and no Whoop connected has every past run
 * marked `skipped` and is told they missed everything, when the truth is the app cannot see what
 * they did. That is wrong on the dashboard, and worse in the training record — a card targeting
 * one of those runs would record a fabricated "the athlete skipped it", which is precisely the
 * kind of unrecoverable corruption the rest of this design exists to prevent.
 *
 * The sync watermark is the right signal on its own, and subsumes the connection state: a dead
 * refresh token stops `lastPolledAt` advancing, so days after the token died fall outside
 * coverage without needing a separate `needsReauth` check.
 */
async function workoutCoverageThrough(userId: string): Promise<Date | null> {
  const [state] = await db
    .select({ lastPolledAt: syncState.lastPolledAt })
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "whoop")));
  return state?.lastPolledAt ?? null;
}

/**
 * Decide, for every planned run in the recent past, whether it actually happened.
 *
 * `planned_runs.status` has had a 'completed' value since the first migration and nothing ever
 * wrote it. The plan and the workouts synced from Whoop were two tables that never touched, so
 * the app could show what was intended and what happened but could never say they were the same
 * session — which means it could not answer "am I actually following this plan?", and a
 * recommendation's record stopped at whether the athlete clicked accept.
 *
 * The pass is idempotent and re-derivable: it clears its own previous guesses inside the
 * window and re-decides from the current data, so a workout arriving late, being re-scored, or
 * being deleted all converge on the right answer rather than leaving a stale link behind.
 * Anything the athlete corrected by hand (`match_source = 'manual'`) is excluded from that
 * entirely — those rows are read as fixed points, and their workouts are withheld from the
 * candidate pool so a correction can't be undone by another run stealing its workout.
 *
 * Deliberately does not touch `updated_at`. That column is what Google's inbound sync uses to
 * detect "the app changed this run since the last sync" (see integrations/google/pull.ts); a
 * background sweep bumping it on every pass would make every inbound calendar edit look like a
 * conflict and let the app overwrite the athlete's own edit. Reconciliation stamps
 * `reconciled_at` instead, which nothing else reads.
 */
export async function reconcileUser(
  userId: string,
  opts: { now?: Date; windowDays?: number } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const timeZone = await getAthleteTimezone(userId);

  const todayYmd = dateYmdInZone(now, timeZone);
  const fromYmd = dateYmdInZone(addLocalDays(now, -windowDays, timeZone), timeZone);
  const tomorrowYmd = dateYmdInZone(addLocalDays(now, 1, timeZone), timeZone);

  // Bounded on athlete-local day edges rather than on `now`: a run planned for 7pm tonight that
  // the athlete actually did at 6am is already decidable, and an instant bound would exclude it
  // until the evening.
  const fromInstant = new Date(zonedLocalToIso(fromYmd, "00:00", timeZone));
  const toInstant = new Date(zonedLocalToIso(tomorrowYmd, "00:00", timeZone));

  // Scoped to the runs the app itself shows (active plan + ad-hoc manual runs). Reconciling
  // every plan the athlete has ever imported would let a dormant plan's runs compete for the
  // same workouts as the live one.
  const activePlanId = await getActivePlanId(userId);
  const runRows = await db
    .select({
      id: plannedRuns.id,
      scheduledAt: plannedRuns.scheduledAt,
      runType: plannedRuns.runType,
      distanceM: plannedRuns.distanceM,
      durationMin: plannedRuns.durationMin,
      status: plannedRuns.status,
      actualWorkoutId: plannedRuns.actualWorkoutId,
      matchSource: plannedRuns.matchSource,
    })
    .from(plannedRuns)
    .where(
      and(
        visibleRunsSql(userId, activePlanId),
        gte(plannedRuns.scheduledAt, fromInstant),
        lt(plannedRuns.scheduledAt, toInstant),
      ),
    );

  const workoutRows = await db
    .select({
      id: whoopWorkouts.id,
      date: whoopWorkouts.date,
      startedAt: whoopWorkouts.startedAt,
      sport: whoopWorkouts.sport,
      distanceM: whoopWorkouts.distanceM,
      durationMin: whoopWorkouts.durationMin,
    })
    .from(whoopWorkouts)
    .where(
      and(
        eq(whoopWorkouts.userId, userId),
        gte(whoopWorkouts.date, fromYmd),
        // `date` is a plain YYYY-MM-DD string column, so this is a lexicographic compare —
        // which is the same as a chronological one for ISO dates.
        sql`${whoopWorkouts.date} <= ${todayYmd}`,
      ),
    );

  const manualRuns = runRows.filter((r) => r.matchSource === "manual");
  const autoRuns = runRows.filter((r) => r.matchSource !== "manual");
  const claimedByManual = new Set(
    manualRuns.map((r) => r.actualWorkoutId).filter((id): id is string => id != null),
  );

  const result = matchWorkoutsToRuns(
    autoRuns.map(
      (r): MatchableRun => ({
        id: r.id,
        scheduledAt: r.scheduledAt,
        runType: r.runType,
        distanceM: r.distanceM,
        durationMin: r.durationMin,
      }),
    ),
    workoutRows
      .filter((w) => !claimedByManual.has(w.id))
      .map(
        (w): MatchableWorkout => ({
          id: w.id,
          date: w.date,
          startedAt: w.startedAt,
          sport: w.sport,
          distanceM: w.distanceM,
          durationMin: w.durationMin,
        }),
      ),
    timeZone,
  );

  const byId = new Map(autoRuns.map((r) => [r.id, r]));
  const unmatched = result.unmatchedRunIds.map((id) => byId.get(id)!).filter(Boolean);
  // A run still inside today is simply undecided — the athlete may yet go out — so it is
  // reopened rather than judged.
  const isPastDay = (r: { scheduledAt: Date }) => dateYmdInZone(r.scheduledAt, timeZone) < todayYmd;

  /**
   * "Nothing matched" only means "not done" if we would have seen it had it happened.
   *
   * A day counts as observed once Whoop has been polled past the *end* of it. Comparing against
   * the run's own start time instead would be wrong in the ordinary case: a run planned for 7am
   * and actually done at 8pm would look observed by a 9am poll, and get marked missed.
   */
  const coverageThrough = await workoutCoverageThrough(userId);
  const isObserved = (r: { scheduledAt: Date }) => {
    if (!coverageThrough) return false;
    const dayAfter = dateYmdInZone(addLocalDays(r.scheduledAt, 1, timeZone), timeZone);
    return coverageThrough >= new Date(zonedLocalToIso(dayAfter, "00:00", timeZone));
  };

  const pastUnmatched = unmatched.filter(isPastDay);
  const skippedIds = pastUnmatched.filter(isObserved).map((r) => r.id);
  // Past, unmatched, and unobservable. Left entirely alone — status stays whatever it was and
  // reconciled_at stays null, which is already this codebase's way of saying "no pass has
  // reached a verdict here". Counted so callers can distinguish it from a clean week.
  const untrackedIds = pastUnmatched.filter((r) => !isObserved(r)).map((r) => r.id);
  const openIds = unmatched.filter((r) => !isPastDay(r)).map((r) => r.id);

  if (autoRuns.length > 0) {
    await db.transaction(async (tx) => {
      // Clear every auto link in the window before writing the new ones. The partial unique
      // index on (user_id, actual_workout_id) means reassigning a workout from one run to
      // another would otherwise collide mid-update depending on statement order.
      await tx
        .update(plannedRuns)
        .set({ actualWorkoutId: null })
        .where(
          and(
            eq(plannedRuns.userId, userId),
            inArray(
              plannedRuns.id,
              autoRuns.map((r) => r.id),
            ),
          ),
        );

      for (const match of result.matches) {
        await tx
          .update(plannedRuns)
          .set({
            actualWorkoutId: match.workoutId,
            status: "completed",
            matchSource: "auto",
            reconciledAt: now,
          })
          .where(and(eq(plannedRuns.id, match.runId), eq(plannedRuns.userId, userId)));
      }

      if (skippedIds.length > 0) {
        // match_source stays 'auto' with a null workout: the sweep did reach a verdict here,
        // it was just "nothing". Read with reconciled_at, that is what distinguishes a
        // genuinely missed session from one no pass has looked at yet.
        await tx
          .update(plannedRuns)
          .set({ status: "skipped", matchSource: "auto", reconciledAt: now })
          .where(and(eq(plannedRuns.userId, userId), inArray(plannedRuns.id, skippedIds)));
      }

      if (untrackedIds.length > 0) {
        // Withdraw a verdict this sweep can no longer justify. Scoped to rows the sweep itself
        // wrote (`match_source = 'auto'`) for two reasons: it repairs runs an earlier version
        // wrongly marked skipped when it had no way to observe them, and it leaves everything
        // else — including a `moved` status written by Google's inbound sync — untouched.
        await tx
          .update(plannedRuns)
          .set({ status: "planned", matchSource: null, reconciledAt: null })
          .where(
            and(
              eq(plannedRuns.userId, userId),
              inArray(plannedRuns.id, untrackedIds),
              eq(plannedRuns.matchSource, "auto"),
            ),
          );
      }

      if (openIds.length > 0) {
        // Back to undecided, including reconciled_at — a run today that a previous pass
        // completed off a workout since deleted must not keep reading as reconciled.
        await tx
          .update(plannedRuns)
          .set({ status: "planned", matchSource: null, reconciledAt: null })
          .where(and(eq(plannedRuns.userId, userId), inArray(plannedRuns.id, openIds)));
      }
    });
  }

  // Runs settling is the event that makes a recommendation's outcome knowable, so this is the
  // one place that can notice it. Best-effort: a lost outcome record is not a reason to lose
  // the reconciliation that produced it.
  try {
    await recordSettledOutcomes(userId, { now, timeZone });
  } catch (err) {
    logger.warn({ err, userId }, "failed to record recommendation outcomes after reconciliation");
  }

  return {
    completed: result.matches.length,
    skipped: skippedIds.length,
    reopened: openIds.length,
    untracked: untrackedIds.length,
  };
}

/** Boundary wrapper, matching generateRecommendationsSafe: reconciliation is a background
 * bookkeeping pass, and it failing should never take down the sync or the request that
 * triggered it. */
export async function reconcileUserSafe(
  userId: string,
  opts: { now?: Date; windowDays?: number } = {},
): Promise<ReconcileResult | null> {
  try {
    return await reconcileUser(userId, opts);
  } catch (err) {
    logger.error({ err, userId }, "reconciliation sweep failed");
    return null;
  }
}
