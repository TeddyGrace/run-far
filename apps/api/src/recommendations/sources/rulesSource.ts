import type { RecommendationSource } from "./types.js";
import { evaluate } from "../evaluate.js";

/**
 * The deterministic rules engine, as a source. A thin adapter on purpose: `evaluate()` and the
 * rules themselves stay pure, synchronous and TypeScript, and this wrapper is the only thing
 * that knows they now sit behind an async interface.
 *
 * `version` is null because the rules are versioned by the repository, not by a column — a
 * change to a rule is a deploy, and git already records which one.
 */
export const rulesSource: RecommendationSource = {
  id: "rules",
  version: null,
  generate: async (ctx) => evaluate(ctx),
};
