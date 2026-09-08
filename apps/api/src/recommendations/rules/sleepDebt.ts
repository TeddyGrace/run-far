import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule, PlannedRunRow } from "../types.js";
import { todaysRun, isHardRun, runsOnLocalDate } from "./shared.js";
import { addLocalDays, dateYmdInZone } from "../../lib/zonedTime.js";

/** How many days forward to look for an empty day to move the session onto. */
const MAX_SHIFT_DAYS = 3;

/** The first local day within `MAX_SHIFT_DAYS` that has no other run scheduled on it. Pushing a
 * session onto a day that already has one just double-books the athlete, which is what the
 * blind +1 day this replaced did whenever the plan had back-to-back sessions. */
function firstFreeDayShift(
  run: PlannedRunRow,
  upcoming: PlannedRunRow[],
  timeZone: string,
): { target: Date; days: number } | null {
  for (let days = 1; days <= MAX_SHIFT_DAYS; days++) {
    const target = addLocalDays(run.scheduledAt, days, timeZone);
    const targetDate = dateYmdInZone(target, timeZone);
    const occupied = runsOnLocalDate(upcoming, targetDate, timeZone).some((r) => r.id !== run.id);
    if (!occupied) return { target, days };
  }
  return null;
}

/** Today's (rolling) sleep debt is over the threshold: shift today's hard session later
 * rather than cutting it, since sleep debt is often a 1-2 day problem, not a plan-wide one.
 * Whoop's sleep debt figure already carries forward night-to-night, so today's value alone
 * reflects accumulated debt — it must never be summed across multiple days.
 *
 * The shift goes through `addLocalDays`, not `setUTCDate(+1)`: adding 24h in UTC moves the
 * athlete's wall-clock run time by an hour across a DST boundary. */
export const sleepDebt: Rule = ({ snapshot, upcoming, timeZone, now }) => {
  const debt = snapshot.sleepDebtMinToday;
  if (debt == null || debt < RECOMMENDATION_CONFIG.sleepDebt.thresholdMin) return null;

  const run = todaysRun(upcoming, timeZone, now);
  if (!isHardRun(run) || !run) return null;

  const hours = (debt / 60).toFixed(1);
  const shift = firstFreeDayShift(run, upcoming, timeZone);

  // Every day in reach already has a run on it — there's nowhere to push this without
  // double-booking, so the card stays advisory (same shape as acwr-spike) rather than
  // proposing a change the athlete would have to undo.
  if (!shift) {
    return {
      ruleId: "sleep-debt",
      severity: "yellow",
      summary: `${hours}h of sleep debt today — the ${run.runType} run is worth easing off`,
      reason: `You're carrying about ${hours} hours of sleep debt today. The next ${MAX_SHIFT_DAYS} days all already have runs scheduled, so there's no clear day to push the ${run.runType} session onto — consider trimming it instead, or moving something else yourself.`,
      proposedChanges: [],
    };
  }

  const dayWord = shift.days === 1 ? "a day" : `${shift.days} days`;
  return {
    ruleId: "sleep-debt",
    severity: "yellow",
    summary: `${hours}h of sleep debt today — push the ${run.runType} run back ${dayWord}`,
    reason: `You're carrying about ${hours} hours of sleep debt today. Rather than cutting the ${run.runType} session, shift it ${dayWord} later — to ${shift.target.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone })}, the nearest day with nothing else scheduled — to give sleep a chance to catch up first.`,
    proposedChanges: [
      {
        plannedRunId: run.id,
        field: "scheduledAt",
        from: run.scheduledAt.toISOString(),
        to: shift.target.toISOString(),
      },
    ],
  };
};
