import type { RecommendationSource } from "./types.js";

/**
 * Placeholder for the machine-learned source. Returns nothing, so enabling it changes no
 * behavior — the point of shipping it now is the seam and the attribution column, not the model.
 *
 * When a real model lands it goes *here*, behind this interface, as either an HTTP call to a
 * scoring service (RuleContext.snapshot is already the feature vector, and RecoverySnapshot is
 * a Zod schema so it serializes as-is) or a read of a table some offline job precomputed. It
 * must not be written as a rule: rules are pure, synchronous and in-process, and a model is
 * none of those things. Keeping that boundary is what lets Python exist in this system without
 * the API becoming a Python app.
 *
 * Whatever the implementation, it must fail open — see `gather()` in ./index.ts. A scoring
 * service being down has to degrade to rules-only, never to an empty recommendation set.
 */
export const modelSource: RecommendationSource = {
  id: "model",
  version: null,
  generate: async () => [],
};
