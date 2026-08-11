import type { RuleContext, RuleOutput } from "./types.js";
import { ALL_RULES } from "./rules/index.js";

export interface EvaluationResult {
  primary: RuleOutput | null;
  secondary: RuleOutput[];
}

const SEVERITY_RANK: Record<string, number> = { red: 3, yellow: 2, info: 1 };

/**
 * Runs every rule against the given context and returns the highest-severity applicable
 * one as `primary`; everything else that also fired becomes a `secondary` note. Pure and
 * synchronous — all I/O (building the snapshot, loading upcoming runs) happens before this
 * is called, which is what makes rule logic itself trivial to unit test.
 */
export function evaluate(ctx: RuleContext): EvaluationResult {
  const fired = ALL_RULES.map((rule) => rule(ctx)).filter((r): r is RuleOutput => r != null);
  if (fired.length === 0) return { primary: null, secondary: [] };

  const sorted = [...fired].sort(
    (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
  );
  const [primary, ...secondary] = sorted;
  return { primary: primary ?? null, secondary };
}
