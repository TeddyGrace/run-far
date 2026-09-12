/**
 * HKWorkoutActivityType → the sport vocabulary the rest of run-far already speaks.
 *
 * That vocabulary is Whoop's `sport_name` strings, because Whoop was the first provider. It is
 * not a neutral naming scheme and there is no value in inventing one: `shared/sports.ts`
 * RUN_SPORTS, the reconciliation matcher, and the frontend's filter chips and labels all key
 * off these exact strings. Mapping Apple's names onto them at the boundary means an Apple
 * athlete's run is a candidate to satisfy a planned run, counts toward weekly mileage, and
 * renders with the same "Run" chip — none of which would happen if Apple workouts arrived
 * labelled "running" vs "Running" vs "HKWorkoutActivityTypeRunning".
 *
 * Deliberately conservative: an activity type we don't recognize keeps Apple's own name rather
 * than being coerced into something close. An unrecognized sport shows up as an activity with
 * an odd label, which is a cosmetic problem; a wrong one that lands in RUN_SPORTS silently
 * corrupts adherence and mileage, which is not.
 */

/** Apple activity types that are running, split by where the run happened. The indoor flag is
 * what separates a treadmill run from a road run — see resolveSport. */
const APPLE_SPORT_MAP: Record<string, string> = {
  // --- Runs ---
  running: "running",
  // Apple has no distinct trail-running type; a trail run is recorded as `running` (and, on
  // newer watchOS, `trailRunning` when the athlete picks it explicitly).
  trailRunning: "trail_running",

  // --- Everything else, mapped onto the names the frontend already has labels for ---
  walking: "walking",
  hiking: "hiking",
  cycling: "cycling",
  handCycling: "cycling",
  swimming: "swimming",
  yoga: "yoga",
  traditionalStrengthTraining: "weightlifting",
  functionalStrengthTraining: "functional_fitness",
  highIntensityIntervalTraining: "functional_fitness",
  crossTraining: "functional_fitness",
  coreTraining: "functional_fitness",
  elliptical: "elliptical",
  rowing: "rowing",
  stairClimbing: "stairs",
  stairs: "stairs",
  mixedCardio: "activity",
  other: "activity",
};

/** Treadmill/indoor variants, applied only when the workout is flagged indoor. Keyed on the
 * *mapped* run sport so an indoor `trailRunning` (which makes no sense, but is expressible)
 * still resolves to a treadmill run rather than staying trail. */
const INDOOR_OVERRIDES: Record<string, string> = {
  running: "treadmill_running",
  trail_running: "treadmill_running",
};

/**
 * The sport name to store for an Apple workout.
 *
 * `indoor` comes from HKMetadataKeyIndoorWorkout. It matters beyond labelling: a
 * treadmill_running row with no distance is an expected shape (no GPS to measure it), which is
 * precisely the case the manual-distance entry path exists for, whereas a `running` row with no
 * distance suggests a recording problem.
 */
export function resolveSport(activityType: string, indoor: boolean): string {
  const mapped = APPLE_SPORT_MAP[activityType] ?? activityType;
  if (!indoor) return mapped;
  return INDOOR_OVERRIDES[mapped] ?? mapped;
}
