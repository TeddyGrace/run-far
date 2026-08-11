import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";
import { nextRun, isHardRun } from "./shared.js";

/** Cumulative 7-day sleep debt is over the threshold: shift the next hard session later
 * rather than cutting it, since sleep debt is often a 1-2 day problem, not a plan-wide one. */
export const sleepDebt: Rule = ({ snapshot, upcoming }) => {
  const debt = snapshot.sleepDebtMin7d;
  if (debt == null || debt < RECOMMENDATION_CONFIG.sleepDebt.thresholdMin7d) return null;

  const run = nextRun(upcoming);
  if (!isHardRun(run) || !run) return null;

  const shifted = new Date(run.scheduledAt);
  shifted.setUTCDate(shifted.getUTCDate() + 1);

  const hours = (debt / 60).toFixed(1);
  return {
    ruleId: "sleep-debt",
    severity: "yellow",
    summary: `${hours}h of sleep debt this week — push the ${run.runType} run back a day`,
    reason: `You're carrying about ${hours} hours of sleep debt over the last 7 days. Rather than cutting the ${run.runType} session, shift it a day later to give sleep a chance to catch up first.`,
    proposedChanges: [
      { plannedRunId: run.id, field: "scheduledAt", from: run.scheduledAt.toISOString(), to: shifted.toISOString() },
    ],
  };
};
