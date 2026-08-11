import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";
import { nextRun, isHardRun } from "./shared.js";

/** Recovery is in the yellow zone and a hard session is next: trim volume/intensity, keep the type. */
export const yellowRecoveryHardSession: Rule = ({ snapshot, upcoming }) => {
  const { redMax, yellowMax } = RECOMMENDATION_CONFIG.recovery;
  if (
    snapshot.recoveryScore == null ||
    snapshot.recoveryScore <= redMax ||
    snapshot.recoveryScore > yellowMax
  ) {
    return null;
  }
  const run = nextRun(upcoming);
  if (!isHardRun(run) || !run) return null;

  const pct = RECOMMENDATION_CONFIG.volumeReduction.yellowPct;
  const newDuration = run.durationMin != null ? Math.round(run.durationMin * (1 - pct)) : null;
  const newDistance = run.distanceM != null ? Math.round(run.distanceM * (1 - pct)) : null;

  return {
    ruleId: "yellow-recovery-hard-session",
    severity: "yellow",
    summary: `Recovery is ${snapshot.recoveryScore}% (yellow) — trim the ${run.runType} run by ${Math.round(pct * 100)}%`,
    reason: `Your recovery score is ${snapshot.recoveryScore}%, in the yellow zone (${redMax + 1}–${yellowMax}%). Keep the ${run.runType} session, but reduce volume and intensity by about ${Math.round(pct * 100)}% to stay within what your body can absorb today.`,
    proposedChanges: [
      ...(newDuration != null
        ? [{ plannedRunId: run.id, field: "durationMin", from: run.durationMin, to: newDuration }]
        : []),
      ...(newDistance != null
        ? [{ plannedRunId: run.id, field: "distanceM", from: run.distanceM, to: newDistance }]
        : []),
    ],
  };
};
