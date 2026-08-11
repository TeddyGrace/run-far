import { RECOMMENDATION_CONFIG } from "../config.js";
import type { Rule } from "../types.js";
import { nextRun, isHardRun } from "./shared.js";

/**
 * HRV has been more than N SDs below baseline for at least `minConsecutiveDays`. This can
 * flag risk even when the headline recovery score looks acceptable — HRV suppression often
 * shows up before the composite score does. A single suppressed day is common noise, so
 * the consecutive-day count (computed by the snapshot builder, which has the history this
 * rule doesn't) is what actually gates the rule.
 */
export const hrvSuppressed: Rule = ({ snapshot, upcoming }) => {
  const { hrvRmssdMs, hrvBaselineMs, hrvBaselineSd, hrvSuppressedConsecutiveDays } = snapshot;
  if (hrvRmssdMs == null || hrvBaselineMs == null || hrvBaselineSd == null || hrvBaselineSd === 0) {
    return null;
  }
  if (hrvSuppressedConsecutiveDays < RECOMMENDATION_CONFIG.hrv.minConsecutiveDays) return null;
  const sdBelow = (hrvBaselineMs - hrvRmssdMs) / hrvBaselineSd;

  const run = nextRun(upcoming);
  const runNote = isHardRun(run) && run ? ` The planned ${run.runType} session is a candidate to ease back.` : "";

  return {
    ruleId: "hrv-suppressed",
    severity: "yellow",
    summary: `HRV has been suppressed for ${hrvSuppressedConsecutiveDays} days — recovery may be lower than the score suggests`,
    reason: `Your HRV (${hrvRmssdMs.toFixed(1)}ms) has been ${sdBelow.toFixed(1)} SD below your rolling baseline (${hrvBaselineMs.toFixed(1)}ms) for ${hrvSuppressedConsecutiveDays} consecutive days. This can precede a drop in the composite recovery score by a day or two.${runNote}`,
    proposedChanges:
      isHardRun(run) && run
        ? [{ plannedRunId: run.id, field: "runType", from: run.runType, to: "easy" }]
        : [],
  };
};
