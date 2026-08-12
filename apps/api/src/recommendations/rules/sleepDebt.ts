import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";
import { nextRun, isHardRun } from "./shared.js";

/** Today's (rolling) sleep debt is over the threshold: shift the next hard session later
 * rather than cutting it, since sleep debt is often a 1-2 day problem, not a plan-wide one.
 * Whoop's sleep debt figure already carries forward night-to-night, so today's value alone
 * reflects accumulated debt — it must never be summed across multiple days. */
export const sleepDebt: Rule = ({ snapshot, upcoming }) => {
  const debt = snapshot.sleepDebtMinToday;
  if (debt == null || debt < RECOMMENDATION_CONFIG.sleepDebt.thresholdMin) return null;

  const run = nextRun(upcoming);
  if (!isHardRun(run) || !run) return null;

  const shifted = new Date(run.scheduledAt);
  shifted.setUTCDate(shifted.getUTCDate() + 1);

  const hours = (debt / 60).toFixed(1);
  return {
    ruleId: "sleep-debt",
    severity: "yellow",
    summary: `${hours}h of sleep debt today — push the ${run.runType} run back a day`,
    reason: `You're carrying about ${hours} hours of sleep debt today. Rather than cutting the ${run.runType} session, shift it a day later to give sleep a chance to catch up first.`,
    proposedChanges: [
      { plannedRunId: run.id, field: "scheduledAt", from: run.scheduledAt.toISOString(), to: shifted.toISOString() },
    ],
  };
};
