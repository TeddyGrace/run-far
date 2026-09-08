import type { RuleContext, RuleOutput } from "./types.js";
import { ALL_RULES } from "./rules/index.js";

const SEVERITY_RANK: Record<string, number> = { red: 3, yellow: 2, info: 1 };

/**
 * Runs every rule against the given context and returns the ones that fired in priority
 * order — the caller treats index 0 as the primary card and the rest as secondary notes.
 * Pure and synchronous: all I/O (building the snapshot, loading upcoming runs) happens
 * before this is called, which is what makes rule logic itself trivial to unit test.
 *
 * Ordering, in decreasing precedence:
 *  1. Severity (red > yellow > info).
 *  2. Actionable before advisory. A rule with proposed changes gives the athlete something
 *     to do; one without can only be dismissed. Without this, a Severe NWS weather alert
 *     (which weatherAdvisory reports as "red") headlines the dashboard over a red-recovery
 *     override that actually wants to change today's session.
 *  3. Declared order in ALL_RULES — Array.prototype.sort is stable, so ties fall through to it.
 */
export function evaluate(ctx: RuleContext): RuleOutput[] {
  const fired = ALL_RULES.map((rule) => rule(ctx)).filter((r): r is RuleOutput => r != null);

  return [...fired].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    return Number(b.proposedChanges.length > 0) - Number(a.proposedChanges.length > 0);
  });
}
