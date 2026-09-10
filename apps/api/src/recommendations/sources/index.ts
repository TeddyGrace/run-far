import type { RuleContext } from "../types.js";
import type { RecommendationSource, SourcedOutput } from "./types.js";
import { rulesSource } from "./rulesSource.js";
import { modelSource } from "./modelSource.js";
import { ENGINE_CONFIG } from "../config.js";
import { logger } from "../../lib/logger.js";

export type { RecommendationSource, SourcedOutput } from "./types.js";
export { rulesSource } from "./rulesSource.js";
export { modelSource } from "./modelSource.js";

/** Every source the engine knows about, in the order they are offered to ranking — which is
 * also the cross-source tiebreaker, so rules first. */
export const ALL_SOURCES: RecommendationSource[] = [rulesSource, modelSource];

/** Every id that has ever been written to recommendations.source. Used by the retraction sweep
 * to recognise its own rows. */
export const ALL_SOURCE_IDS: string[] = ALL_SOURCES.map((s) => s.id);

export interface SourcePlan {
  /** Arbitrated together and shown to the athlete. */
  rendered: RecommendationSource[];
  /** Arbitrated separately, persisted, never shown — the scoring record. */
  shadow: RecommendationSource[];
}

/**
 * Decides which sources run, and in which capacity, for one regeneration.
 *
 * The model runs in shadow on ingestion events (Whoop webhooks, the nightly sync) whether or not
 * it is switched on, which is what accumulates a continuous accept/dismiss record to score a
 * candidate model against. It is skipped on plain dashboard reads so that a future scoring call
 * doesn't land in the latency path of every page load.
 *
 * When it *is* switched on it runs on every regeneration, dashboard reads included. That isn't a
 * preference — arbitrate() can only guarantee one card per run across outputs it sees in a single
 * call, so a rendered source that skipped some regenerations could leave a stale card pending
 * against a run a fresh rules card also wants, and accepting both is exactly the incoherent state
 * arbitration exists to prevent.
 */
export function planSources(opts: { modelRendered: boolean; ingestion: boolean }): SourcePlan {
  if (opts.modelRendered) {
    return { rendered: [rulesSource, modelSource], shadow: [] };
  }
  return { rendered: [rulesSource], shadow: opts.ingestion ? [modelSource] : [] };
}

/**
 * Runs one source, tagging each output with its producer.
 *
 * Non-`rules` sources fail open: a throw or a timeout logs and yields no outputs, so a model
 * scoring service that is down or slow degrades the athlete to rules-only rather than to an
 * empty dashboard. Errors from the rules source propagate — it is in-process and pure, a throw
 * there is a real bug, and generateRecommendationsSafe already catches at the boundary. Silently
 * swallowing it would turn "the engine is broken" into "you have no recommendations today".
 */
export async function gather(
  source: RecommendationSource,
  ctx: RuleContext,
  userId: string,
): Promise<SourcedOutput[]> {
  const run = async () => {
    const outputs = await source.generate(ctx);
    return outputs.map((output) => ({ source, output }));
  };

  if (source.id === rulesSource.id) return run();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`source '${source.id}' timed out`)),
          ENGINE_CONFIG.sources.timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    logger.warn({ err, userId, source: source.id }, "recommendation source failed — skipping");
    return [];
  } finally {
    clearTimeout(timer);
  }
}
