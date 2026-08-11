import type { RecoverySnapshot, RecommendationSeverity, ProposedChange } from "@run-far/shared";
import type { plannedRuns } from "../db/schema.js";

export type PlannedRunRow = typeof plannedRuns.$inferSelect;

export interface BusyPeriod {
  start: Date;
  end: Date;
}

export interface RuleContext {
  snapshot: RecoverySnapshot;
  /** Runs scheduled today through the end of the plan's next hard session — enough
   * lookahead for a rule to decide whether to touch tomorrow's or next week's session. */
  upcoming: PlannedRunRow[];
  /** Busy periods from the user's primary Google Calendar. Empty if Google isn't
   * connected — calendar-conflict simply never fires in that case. */
  busyPeriods: BusyPeriod[];
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
