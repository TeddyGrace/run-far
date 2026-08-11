import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";
import { nextRun, isHardRun } from "./shared.js";

/** Recovery is in the red zone and a hard session is next: downgrade to easy/rest. */
export const redRecoveryHardSession: Rule = ({ snapshot, upcoming }) => {
  if (snapshot.recoveryScore == null || snapshot.recoveryScore > RECOMMENDATION_CONFIG.recovery.redMax) {
    return null;
  }
  const run = nextRun(upcoming);
  if (!isHardRun(run) || !run) return null;

  return {
    ruleId: "red-recovery-hard-session",
    severity: "red",
    summary: `Recovery is ${snapshot.recoveryScore}% (red) — downgrade the ${run.runType} run to easy`,
    reason: `Your recovery score is ${snapshot.recoveryScore}%, in the red zone (≤${RECOMMENDATION_CONFIG.recovery.redMax}%). Running the planned ${run.runType} session as scheduled risks overtraining. Swap it for an easy or rest day and reassess tomorrow.`,
    proposedChanges: [
      { plannedRunId: run.id, field: "runType", from: run.runType, to: "easy" },
      { plannedRunId: run.id, field: "targetPaceSPerKm", from: run.targetPaceSPerKm, to: null },
    ],
  };
};
