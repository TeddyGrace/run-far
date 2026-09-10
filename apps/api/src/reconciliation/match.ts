import { isRunSport } from "@run-far/shared";

import { dateYmdInZone } from "../lib/zonedTime.js";

/**
 * Matching planned runs to the workouts Whoop synced.
 *
 * Pure, for the same reason the rules engine is: the interesting behaviour here is a heuristic
 * with judgement calls in it (which of two runs on a double day owns which workout), and that is
 * only worth having if it can be pinned down by fixtures instead of argued about. All I/O lives
 * in service.ts.
 *
 * The heuristic is deliberately conservative — a wrong link is worse than no link, because a
 * wrong link silently corrupts the adherence figure and, downstream, the outcome attached to a
 * recommendation. Two gates do most of that work: the workout must be a run sport, and it must
 * fall on the same athlete-local calendar day as the planned run. Time-of-day only ranks
 * candidates within a day; it never rescues one across a day boundary. An athlete who plans a
 * 7am run and does it at 8pm still gets the match, which is the common case; one who plans
 * Tuesday and runs Wednesday does not, which is the case the athlete should correct by hand.
 */

/** A planned run, projected down to what matching needs. */
export interface MatchableRun {
  id: string;
  scheduledAt: Date;
  runType: string;
  distanceM: number | null;
  durationMin: number | null;
}

/** A synced Whoop workout, projected down to what matching needs. */
export interface MatchableWorkout {
  id: string;
  /** Athlete-local calendar date, bucketed at ingest (see toLocalDateOnly in whoop/sync.ts). */
  date: string;
  startedAt: Date | null;
  sport: string | null;
  distanceM: number | null;
  durationMin: number | null;
}

export interface RunWorkoutMatch {
  runId: string;
  workoutId: string;
  /** Signed minutes between the workout's start and the planned time; null when the workout
   * has no start instant. Persisted nowhere — it exists so tests and logs can see *why* one
   * candidate beat another. */
  deltaMin: number | null;
}

export interface MatchResult {
  matches: RunWorkoutMatch[];
  unmatchedRunIds: string[];
  unmatchedWorkoutIds: string[];
}

/** A workout with no start instant can still match on its date, but it must lose to any timed
 * candidate on the same day — this is the cost that guarantees it sorts last. */
const UNTIMED_COST_MIN = 24 * 60;

/** A rest day has no session to execute, so nothing can complete it. Runs of this type are
 * excluded from matching entirely rather than being reported as perpetually skipped. */
const NON_EXECUTABLE_RUN_TYPES = new Set(["rest"]);

interface Candidate {
  runId: string;
  workoutId: string;
  deltaMin: number | null;
  cost: number;
}

/**
 * Greedy best-first assignment: score every legal (run, workout) pair, then repeatedly take the
 * cheapest pair whose run and workout are both still free.
 *
 * Greedy rather than optimal (Hungarian) on purpose. The pathological case optimal assignment
 * exists to solve needs two planned runs and two workouts on the same day whose best pairings
 * cross — a double day where the athlete ran them in the opposite order to how they were
 * planned. Against that, greedy costs one wrong link the athlete can fix in a click, and it is
 * roughly twenty lines instead of a hundred. Revisit if double days turn out to be common.
 */
export function matchWorkoutsToRuns(
  runs: MatchableRun[],
  workouts: MatchableWorkout[],
  timeZone: string,
): MatchResult {
  const eligibleRuns = runs.filter((r) => !NON_EXECUTABLE_RUN_TYPES.has(r.runType));
  const eligibleWorkouts = workouts.filter((w) => isRunSport(w.sport));

  const candidates: Candidate[] = [];
  for (const run of eligibleRuns) {
    const runDate = dateYmdInZone(run.scheduledAt, timeZone);
    for (const workout of eligibleWorkouts) {
      if (workout.date !== runDate) continue;
      const deltaMin = workout.startedAt
        ? (workout.startedAt.getTime() - run.scheduledAt.getTime()) / 60_000
        : null;
      candidates.push({
        runId: run.id,
        workoutId: workout.id,
        deltaMin,
        cost: deltaMin === null ? UNTIMED_COST_MIN : Math.abs(deltaMin),
      });
    }
  }

  // Ties are broken on the ids so the result is a function of the inputs alone — otherwise two
  // equidistant workouts would be assigned in whatever order the database happened to return.
  candidates.sort(
    (a, b) =>
      a.cost - b.cost || a.runId.localeCompare(b.runId) || a.workoutId.localeCompare(b.workoutId),
  );

  const takenRuns = new Set<string>();
  const takenWorkouts = new Set<string>();
  const matches: RunWorkoutMatch[] = [];
  for (const c of candidates) {
    if (takenRuns.has(c.runId) || takenWorkouts.has(c.workoutId)) continue;
    takenRuns.add(c.runId);
    takenWorkouts.add(c.workoutId);
    matches.push({ runId: c.runId, workoutId: c.workoutId, deltaMin: c.deltaMin });
  }

  return {
    matches,
    // Rest days are not reported as unmatched: they were never candidates, and calling them
    // unmatched would make them look skipped to every caller downstream.
    unmatchedRunIds: eligibleRuns.filter((r) => !takenRuns.has(r.id)).map((r) => r.id),
    // Non-run workouts likewise stay out — a strength session is not a failed run match, and
    // surfacing it in a "which workout did you mean?" picker would only be noise.
    unmatchedWorkoutIds: eligibleWorkouts.filter((w) => !takenWorkouts.has(w.id)).map((w) => w.id),
  };
}
