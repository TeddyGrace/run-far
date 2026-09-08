import type { RuleOutput } from "./types.js";

/**
 * Resolves the case where several rules want to change the same planned run.
 *
 * Recovery, sleep debt, HRV and calendar conflicts can all fire against the same session on
 * the same day — sleep-debt wanting to move it, yellow-recovery wanting to trim it, calendar
 * conflict wanting to retime it. Persisted as separate cards they were each independently
 * acceptable, so accepting two produced incoherent state (a run trimmed for a day it was no
 * longer scheduled on, a conflict "resolved" onto a day the run had already been pushed off).
 *
 * Policy is one card per run: walking the already-ranked list, the highest-ranked rule to
 * propose a change to a run claims it. A lower-ranked rule that only had claimed runs to talk
 * about is demoted — it isn't persisted as its own card, its summary rides along in the reason
 * of the card that claimed the run, so the athlete still sees the observation without being
 * offered a second, conflicting button. Rules that never proposed changes (acwr-spike,
 * weather-advisory) are advisory by nature and pass through untouched.
 *
 * `ordered` must already be in priority order — see evaluate().
 */
export function arbitrate(ordered: RuleOutput[]): RuleOutput[] {
  const claimedRuns = new Set<string>();
  /** Index in `kept` of the card that claimed a given run id. */
  const claimedBy = new Map<string, number>();
  const kept: RuleOutput[] = [];

  for (const rule of ordered) {
    if (rule.proposedChanges.length === 0) {
      kept.push({ ...rule }); // advisory by nature — never competes for a run
      continue;
    }

    const surviving = rule.proposedChanges.filter((c) => !claimedRuns.has(c.plannedRunId));

    if (surviving.length === 0) {
      // Every run this rule wanted is already spoken for: fold it into the owning card.
      const ownerIndex = claimedBy.get(rule.proposedChanges[0]!.plannedRunId);
      const owner = ownerIndex != null ? kept[ownerIndex] : undefined;
      if (owner) owner.reason = `${owner.reason} Also noted: ${rule.summary}.`;
      continue;
    }

    const index = kept.length;
    kept.push({ ...rule, proposedChanges: surviving });
    for (const c of surviving) {
      claimedRuns.add(c.plannedRunId);
      claimedBy.set(c.plannedRunId, index);
    }
  }

  return kept;
}
