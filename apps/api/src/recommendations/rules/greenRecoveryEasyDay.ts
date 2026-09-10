import type { Rule } from "../types.js";
import { todaysRun, isHardRun } from "./shared.js";

/** High recovery with nothing hard scheduled today: offer to swap today's easy session with
 * an upcoming quality one. It's a two-way swap, not a one-way move — writing only the hard
 * run's new time (which is what this rule used to do) left today's easy run sitting at the
 * exact same instant, stacking two runs on top of each other. */
export const greenRecoveryEasyDay: Rule = ({ snapshot, upcoming, timeZone, now, thresholds }) => {
  if (snapshot.recoveryScore == null || snapshot.recoveryScore <= thresholds.recoveryYellowMax) {
    return null;
  }
  const today = todaysRun(upcoming, timeZone, now);
  if (!today || isHardRun(today)) return null; // already a hard day, or nothing scheduled today

  const sortedUpcoming = [...upcoming].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const laterHardRun = sortedUpcoming.find((r) => r.id !== today.id && isHardRun(r));
  if (!laterHardRun) return null;

  const laterDay = laterHardRun.scheduledAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone,
  });

  return {
    ruleId: "green-recovery-easy-day",
    severity: "info",
    summary: `Recovery is ${snapshot.recoveryScore}% (green) — consider swapping today's ${today.runType} run with ${laterDay}'s ${laterHardRun.runType}`,
    reason: `Recovery is strong at ${snapshot.recoveryScore}%, and today is only scheduled as ${today.runType}. If the ${laterHardRun.runType} run on ${laterDay} would benefit from good legs, this is a candidate day for it — the two sessions trade places, so the week's total stays the same. Entirely optional.`,
    proposedChanges: [
      {
        plannedRunId: laterHardRun.id,
        field: "scheduledAt",
        from: laterHardRun.scheduledAt.toISOString(),
        to: today.scheduledAt.toISOString(),
      },
      {
        plannedRunId: today.id,
        field: "scheduledAt",
        from: today.scheduledAt.toISOString(),
        to: laterHardRun.scheduledAt.toISOString(),
      },
    ],
  };
};
