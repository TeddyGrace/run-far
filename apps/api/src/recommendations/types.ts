import type { RecoverySnapshot, RecommendationSeverity, ProposedChange } from "@run-far/shared";
import type { plannedRuns } from "../db/schema.js";
import type { DailyForecast } from "../integrations/weather/weatherClient.js";

export type PlannedRunRow = typeof plannedRuns.$inferSelect;

export interface BusyPeriod {
  start: Date;
  end: Date;
  /** Event title, when available (events.list has it; older freebusy-only call sites don't).
   * Purely cosmetic — lets a rule say what a conflict is, not just that one exists. */
  summary?: string;
}

export interface RuleContext {
  snapshot: RecoverySnapshot;
  /** Runs scheduled today through the end of the plan's next hard session — enough
   * lookahead for a rule to decide whether to touch tomorrow's or next week's session. */
  upcoming: PlannedRunRow[];
  /** Busy periods from the user's primary Google Calendar — timed, accepted, opaque events
   * only (all-day, declined, and "Free"-marked events are filtered out before this is built).
   * Empty if Google isn't connected — calendar-conflict simply never fires in that case. */
  busyPeriods: BusyPeriod[];
  /** NWS daily forecasts for the lookahead window, one row per calendar date. Empty if
   * the athlete's location isn't configured or the NWS call failed — weatherAdvisory simply never
   * fires in that case. */
  weatherForecast: DailyForecast[];
  /** IANA timezone the athlete sees wall-clock times in — the athlete's configured timezone,
   * resolved via getAthleteTimezone (falling back to env.ATHLETE_TIMEZONE). Passed in rather
   * than resolved inside a rule, so rules stay pure functions of their input. */
  timeZone: string;
}

export interface RuleOutput {
  ruleId: string;
  severity: RecommendationSeverity;
  summary: string;
  reason: string;
  proposedChanges: ProposedChange[];
}

/** A rule is a pure function: same inputs, same output, no I/O. This is what makes the
 * engine unit-testable against fixture snapshots without touching a database. */
export type Rule = (ctx: RuleContext) => RuleOutput | null;
