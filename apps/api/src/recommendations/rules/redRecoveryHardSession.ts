import type { Rule } from "../types.js";
import { todaysRun, isHardRun } from "./shared.js";

/** Recovery is in the red zone and a hard session is next: downgrade to easy/rest. */
export const redRecoveryHardSession: Rule = ({ snapshot, upcoming, timeZone, now, thresholds }) => {
  if (snapshot.recoveryScore == null || snapshot.recoveryScore > thresholds.recoveryRedMax) {
    return null;
  }
  const run = todaysRun(upcoming, timeZone, now);
  if (!isHardRun(run) || !run) return null;

  return {
    ruleId: "red-recovery-hard-session",
    severity: "red",
    summary: `Recovery is ${snapshot.recoveryScore}% (red) — downgrade the ${run.runType} run to easy`,
    reason: `Your recovery score is ${snapshot.recoveryScore}%, in the red zone (≤${thresholds.recoveryRedMax}%). Running the planned ${run.runType} session as scheduled risks overtraining. Swap it for an easy or rest day and reassess tomorrow.`,
    proposedChanges: [
      { plannedRunId: run.id, field: "runType", from: run.runType, to: "easy" },
      { plannedRunId: run.id, field: "targetPaceSPerKm", from: run.targetPaceSPerKm, to: null },
    ],
  };
};
