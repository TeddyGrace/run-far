import type { RuleContext, RuleOutput } from "../types.js";

/**
 * A producer of recommendations. The rules engine is one implementation; a machine-learned
 * model is another. Everything downstream — ranking, arbitration, suppression, persistence —
 * consumes `RuleOutput[]` and neither knows nor cares which source produced it.
 *
 * Async by design: `rulesSource` is synchronous under the hood, but a model source is an HTTP
 * call to a scoring service or a read of a precomputed table, and the interface has to admit
 * that without a later signature change.
 */
export interface RecommendationSource {
  /** Persisted verbatim to recommendations.source. Stable — it is a data key, not a label. */
  id: string;
  /** Persisted to recommendations.model_version. Null for deterministic sources. */
  version: string | null;
  generate(ctx: RuleContext): Promise<RuleOutput[]>;
}

/** A source's output paired with its producer, so ranking can apply the safety floor and
 * persistence knows what to write into `source`/`model_version`. */
export interface SourcedOutput {
  source: RecommendationSource;
  output: RuleOutput;
}
