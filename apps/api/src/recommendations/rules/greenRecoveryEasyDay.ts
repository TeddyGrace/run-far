import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";
import { nextRun, isHardRun } from "./shared.js";

/** High recovery with nothing hard scheduled: offer to pull a quality session forward. */
export const greenRecoveryEasyDay: Rule = ({ snapshot, upcoming }) => {
  if (snapshot.recoveryScore == null || snapshot.recoveryScore <= RECOMMENDATION_CONFIG.recovery.yellowMax) {
    return null;
  }
  const today = nextRun(upcoming);
  if (!today || isHardRun(today)) return null; // already a hard day, or nothing scheduled

  const sortedUpcoming = [...upcoming].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const laterHardRun = sortedUpcoming.find((r) => r.id !== today.id && isHardRun(r));
  if (!laterHardRun) return null;

  return {
    ruleId: "green-recovery-easy-day",
    severity: "info",
    summary: `Recovery is ${snapshot.recoveryScore}% (green) — consider pulling the ${laterHardRun.runType} run forward to today`,
    reason: `Recovery is strong at ${snapshot.recoveryScore}%, and today is only scheduled as ${today.runType}. If ${laterHardRun.runType === today.runType ? "the upcoming session" : `the upcoming ${laterHardRun.runType} run`} would benefit from good legs, this is a candidate day to move it up — entirely optional.`,
    proposedChanges: [
      {
        plannedRunId: laterHardRun.id,
        field: "scheduledAt",
        from: laterHardRun.scheduledAt.toISOString(),
        to: today.scheduledAt.toISOString(),
      },
    ],
  };
};
