import type { RuleContext, RuleOutput } from "./types.js";
import type { SourcedOutput } from "./sources/types.js";
import { ALL_RULES } from "./rules/index.js";

const SEVERITY_RANK: Record<string, number> = { red: 3, yellow: 2, info: 1 };

/** The id of the deterministic source, duplicated here rather than imported to keep this module
 * free of a cycle through sources/index.ts (which imports config, logger and the rules source). */
const RULES_SOURCE_ID = "rules";

/**
 * Orders outputs from one or more sources into the priority order the dashboard renders and
 * arbitrate() consumes — index 0 is the primary card.
 *
 * `sourced` must arrive in source order (rules first), and within a source in that source's own
 * declared order. Array.prototype.sort is stable, so that input order is what ties fall through
 * to, which is how the declared order in ALL_RULES stays the final tiebreaker.
 *
 * Ordering, in decreasing precedence:
 *  1. Severity (red > yellow > info).
 *  2. Safety floor: within `red`, the rules engine outranks every other source. The deterministic
 *     recovery override is the one thing that must stay authoritative no matter what a model
 *     says, so it sits above the actionable check below — a red rules card leads even when only
 *     a red model card proposes a change. With a single source this rule is inert, so it changes
 *     nothing about rules-only behavior.
 *  3. Actionable before advisory. A card with proposed changes gives the athlete something to do;
 *     one without can only be dismissed. Without this, a Severe NWS weather alert (which
 *     weatherAdvisory reports as "red") headlines the dashboard over a red-recovery override that
 *     actually wants to change today's session.
 *  4. Input order — source order, then declared rule order.
 */
export function rankOutputs(sourced: SourcedOutput[]): SourcedOutput[] {
  return [...sourced].sort((a, b) => {
    const bySeverity =
      (SEVERITY_RANK[b.output.severity] ?? 0) - (SEVERITY_RANK[a.output.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;

    if (a.output.severity === "red" && b.output.severity === "red") {
      const byFloor =
        Number(b.source.id === RULES_SOURCE_ID) - Number(a.source.id === RULES_SOURCE_ID);
      if (byFloor !== 0) return byFloor;
    }

    return (
      Number(b.output.proposedChanges.length > 0) - Number(a.output.proposedChanges.length > 0)
    );
  });
}

/**
 * Runs every rule against the given context and returns the ones that fired in priority order.
 * Pure and synchronous: all I/O (building the snapshot, loading upcoming runs) happens before
 * this is called, which is what makes rule logic itself trivial to unit test.
 *
 * Ordering is rankOutputs()'s, applied to this one source — see there for the precedence.
 */
export function evaluate(ctx: RuleContext): RuleOutput[] {
  const fired = ALL_RULES.map((rule) => rule(ctx)).filter((r): r is RuleOutput => r != null);

  // rankOutputs works on source-tagged outputs; within evaluate there is only one source and the
  // floor is inert, so a stand-in id is enough to reuse the single ordering definition.
  const source = { id: RULES_SOURCE_ID, version: null, generate: async () => [] };
  return rankOutputs(fired.map((output) => ({ source, output }))).map((s) => s.output);
}
