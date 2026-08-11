import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";

/** Acute:chronic training load ratio is spiking — a ramp-rate warning rather than a
 * same-day session change. Flags info-level; doesn't propose a specific edit. */
export const acwrSpike: Rule = ({ snapshot }) => {
  if (snapshot.acwr == null || snapshot.acwr < RECOMMENDATION_CONFIG.acwr.spikeThreshold) {
    return null;
  }

  return {
    ruleId: "acwr-spike",
    severity: "info",
    summary: `Training load ramping fast (ACWR ${snapshot.acwr.toFixed(2)}) — injury risk is elevated`,
    reason: `Your 7-day acute load is ${snapshot.acwr.toFixed(2)}x your 28-day chronic load, above the ${RECOMMENDATION_CONFIG.acwr.spikeThreshold}x threshold associated with higher injury risk. Consider holding volume flat rather than adding more this week.`,
    proposedChanges: [],
  };
};
