/**
 * Whoop sport names that count as a run.
 *
 * Lives in `shared` rather than in either app because two very different consumers need the
 * same answer: the web activity filter, and the reconciliation matcher, which uses it to
 * decide whether a synced workout is even a candidate to satisfy a planned run. If those two
 * definitions drift, an activity the athlete sees labelled "Run" silently stops counting
 * toward adherence.
 */
export const RUN_SPORTS = ["running", "trail_running", "treadmill_running"] as const;

const RUN_SPORT_SET = new Set<string>(RUN_SPORTS);

export function isRunSport(sport: string | null | undefined): boolean {
  return sport != null && RUN_SPORT_SET.has(sport);
}
