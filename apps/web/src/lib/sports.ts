/** Shared Whoop sport → short label mapping for activity cards and filters. */
const SPORT_LABEL: Record<string, string> = {
  running: "Run",
  cycling: "Ride",
  weightlifting: "Lift",
  weightlifting_msk: "Lift",
  walking: "Walk",
  swimming: "Swim",
  hiking: "Hike",
  yoga: "Yoga",
  functional_fitness: "Lift",
  powerlifting: "Lift",
  activity: "Activity",
};

const RUN_SPORTS = new Set(["running", "trail_running", "treadmill_running"]);
export const STRENGTH_SPORTS = [
  "weightlifting",
  "weightlifting_msk",
  "functional_fitness",
  "powerlifting",
] as const;
const STRENGTH_SPORT_SET = new Set<string>(STRENGTH_SPORTS);

/** Sentinel filter id for the merged Lift chip (covers all strength sports). */
export const LIFT_FILTER = "lift";

export function sportLabel(sport: string | null | undefined): string {
  if (!sport) return "Activity";
  if (sport === LIFT_FILTER || isStrengthSport(sport)) return "Lift";
  return SPORT_LABEL[sport] ?? sport.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isRunSport(sport: string | null | undefined): boolean {
  return sport != null && RUN_SPORTS.has(sport);
}

export function isStrengthSport(sport: string | null | undefined): boolean {
  return sport != null && STRENGTH_SPORT_SET.has(sport);
}

/**
 * Collapse Whoop strength sports into a single "lift" chip for the filter row.
 * Order: Run sports → Lift → everything else (alpha by label).
 */
export function activityFilterChips(sports: string[]): string[] {
  const hasLift = sports.some(isStrengthSport);
  const rest = sports.filter((s) => !isStrengthSport(s));
  const priority = (s: string) => (isRunSport(s) ? 0 : 1);
  rest.sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return sportLabel(a).localeCompare(sportLabel(b));
  });
  if (!hasLift) return rest;
  // Insert Lift immediately after any run sports.
  const firstNonRun = rest.findIndex((s) => !isRunSport(s));
  const insertAt = firstNonRun === -1 ? rest.length : firstNonRun;
  return [...rest.slice(0, insertAt), LIFT_FILTER, ...rest.slice(insertAt)];
}

/** Expand chip ids (including the Lift group) into Whoop sport keys for the API. */
export function expandSportFilters(filters: string[]): string[] {
  const out = new Set<string>();
  for (const f of filters) {
    if (f === LIFT_FILTER) {
      for (const s of STRENGTH_SPORTS) out.add(s);
    } else {
      out.add(f);
    }
  }
  return [...out];
}
