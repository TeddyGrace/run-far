import { and, eq, sql, gte, inArray, notInArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { plannedRuns, recommendations, oauthConnections } from "../db/schema.js";
import { buildRecoverySnapshot } from "./snapshot.js";
import { rankOutputs } from "./evaluate.js";
import { arbitrate } from "./arbitrate.js";
import { fingerprintOf } from "./fingerprint.js";
import { planSources, gather } from "./sources/index.js";
import type { RecommendationSource } from "./sources/index.js";
import type { RuleContext, RuleOutput } from "./types.js";
import { isModelRenderedFor } from "../lib/modelRendering.js";
import { getPrimaryBusyPeriodsCached } from "../integrations/google/calendarClient.js";
import { getForecastsForRules } from "../integrations/weather/forecastStore.js";
import type { DailyForecast } from "../integrations/weather/weatherClient.js";
import { getAthleteLocation } from "../lib/athleteLocation.js";
import { pushPlannedRunToGoogle } from "../integrations/google/push.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";
import { ENGINE_CONFIG } from "./config.js";
import { getRuleThresholds } from "../lib/ruleThresholds.js";
import type { ProposedChange, RecoverySnapshot } from "@run-far/shared";
import { isChangeStale } from "./changeStaleness.js";
import { buildTrainingContext } from "./trainingContext.js";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";
import { maybeSendRecoveryDigest } from "../email/recoveryDigest.js";

const LOOKAHEAD_DAYS = 10;

async function hasGoogleConnection(userId: string): Promise<boolean> {
  const [conn] = await db
    .select({ id: oauthConnections.id })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
  return Boolean(conn);
}

/**
 * A RuleOutput carrying its producer. arbitrate() shallow-copies every output it keeps, so this
 * extra field rides through untouched — which is how persistence learns which source a surviving
 * card came from without arbitrate() having to know that sources exist at all. Internal to the
 * generation path; the `source` field is unpacked into columns before anything is written.
 */
type AttributedOutput = RuleOutput & { source: RecommendationSource };

/** Gathers from every source in a group, ranks the union, and reduces it to at most one card per
 * planned run. Sources run concurrently; Promise.all preserves array order, which is what keeps
 * rankOutputs' source-order tiebreaker meaningful. */
async function arbitrateGroup(
  sources: RecommendationSource[],
  ctx: RuleContext,
  userId: string,
): Promise<AttributedOutput[]> {
  if (sources.length === 0) return [];
  const sourced = (await Promise.all(sources.map((s) => gather(s, ctx, userId)))).flat();
  const attributed = rankOutputs(sourced).map(({ source, output }) => ({ ...output, source }));
  // arbitrate() is deliberately source-agnostic and typed as RuleOutput[]; the copies it returns
  // still carry `source`, so this recovers a fact the call preserved rather than asserting a new one.
  return arbitrate(attributed) as AttributedOutput[];
}

/**
 * Suppresses, upserts and retracts one arbitration group's cards, scoped to that group's sources.
 *
 * Every query here is scoped by `source`, which matters in three separate ways:
 *  - Suppression is keyed on (source, fingerprint), so dismissing a rules card doesn't silently
 *    suppress a model card that happens to say the same thing — the two are being scored
 *    independently and one must not mute the other. Note `fingerprintOf` is deliberately left
 *    alone: folding source into the hash would invalidate every fingerprint already stored and
 *    resurface previously dismissed cards once.
 *  - The upsert targets (user, source, ruleId), so two sources emitting the same ruleId get a row
 *    each instead of overwriting one another.
 *  - Retraction only ever touches `sourceIds`. A source that did not run in this invocation must
 *    keep its rows: dashboard reads regenerate rules only, and an unscoped sweep would delete the
 *    shadow rows written by the last webhook on every single page load, destroying the scoring
 *    record it exists to collect.
 */
async function persistGroup(args: {
  userId: string;
  snapshot: RecoverySnapshot;
  now: Date;
  sourceIds: string[];
  cards: AttributedOutput[];
  /** The same context the sources were gathered against — the planned runs and calendar busy
   * periods the engine actually held. Passed in so each row can persist the slice of it the
   * card depended on; busy periods in particular exist nowhere else once the request ends. */
  ctx: Pick<RuleContext, "upcoming" | "busyPeriods">;
}): Promise<{ ids: string[]; fired: RuleOutput[] }> {
  const { userId, snapshot, now, sourceIds, cards, ctx } = args;
  if (sourceIds.length === 0) return { ids: [], fired: [] };

  // Suppress content the athlete has already resolved (dismissed or accepted) — otherwise every
  // regeneration (dashboard read, webhook, nightly sync) reinserts an identical card the instant
  // the resolved row leaves the pending-only unique index. Fingerprint excludes `date`, so this
  // holds even after the day rolls over. Bounded by a window: without one, accepting or dismissing
  // a card suppressed that exact content forever, so a legitimately recurring situation (the same
  // recurring meeting conflicting with the same run months later) could never surface again.
  const suppressionCutoff = new Date(
    now.getTime() - ENGINE_CONFIG.suppression.windowDays * 24 * 60 * 60 * 1000,
  );
  const fingerprinted = cards.map((card) => ({ card, fingerprint: fingerprintOf(card) }));
  const resolvedKeys = fingerprinted.length
    ? new Set(
        (
          await db
            .select({
              source: recommendations.source,
              fingerprint: recommendations.fingerprint,
            })
            .from(recommendations)
            .where(
              and(
                eq(recommendations.userId, userId),
                inArray(recommendations.source, sourceIds),
                inArray(recommendations.status, ["dismissed", "accepted"]),
                inArray(
                  recommendations.fingerprint,
                  fingerprinted.map((f) => f.fingerprint),
                ),
                gte(recommendations.appliedAt, suppressionCutoff),
              ),
            )
        ).map((r) => `${r.source}:${r.fingerprint}`),
      )
    : new Set<string>();

  const surviving = fingerprinted.filter(
    (f) => !resolvedKeys.has(`${f.card.source.id}:${f.fingerprint}`),
  );

  const ids: string[] = [];
  // `rank` is the index in the surviving priority order, so the dashboard renders index 0 as
  // the primary card without having to re-derive the ranking from severity at read time. Ranks
  // are per group, which is why shadow rows can't disturb the rendered ordering.
  for (const [rank, { card, fingerprint }] of surviving.entries()) {
    // Upsert against the partial unique index (user, source, ruleId) WHERE status='pending' —
    // atomic under concurrency, unlike the delete-then-insert this replaced, which let two
    // regenerations racing for the same user (a webhook and a dashboard read, or two paired
    // webhooks) each insert their own row for the same rule.
    const values = {
      date: snapshot.date,
      severity: card.severity,
      summary: card.summary,
      reason: card.reason,
      inputSnapshot: snapshot,
      proposedChanges: card.proposedChanges,
      // Recomputed on supersede as well as insert: an upsert rewrites the card's content, and
      // a decision context describing the *previous* content would be worse than none.
      decisionContext: buildTrainingContext(card, ctx),
      rank,
      fingerprint,
    };
    const [row] = await db
      .insert(recommendations)
      .values({
        userId,
        ruleId: card.ruleId,
        source: card.source.id,
        modelVersion: card.source.version,
        status: "pending",
        ...values,
      })
      .onConflictDoUpdate({
        target: [recommendations.userId, recommendations.source, recommendations.ruleId],
        targetWhere: eq(recommendations.status, "pending"),
        set: { ...values, modelVersion: card.source.version, createdAt: new Date() },
      })
      .returning({ id: recommendations.id });
    if (row) ids.push(row.id);
  }

  // Retract any pending row for a rule that no longer fires — otherwise a resolved situation
  // (conflict rescheduled away, recovery back in range) leaves a stale card on screen forever,
  // since nothing else ever resolves a pending row. Deliberately NOT scoped to today's date:
  // scoping it there was what let yesterday's cards survive, still proposing edits to runs
  // that have since happened.
  //
  // Expiring rather than deleting. "Shown it, didn't act, the situation passed" is the most
  // common outcome a card has and the clearest negative signal available; deleting the row
  // discarded it on every regeneration, leaving a training set skewed toward the minority of
  // cards someone clicked. The partial unique index is WHERE status = 'pending', so an expired
  // row drops straight out of it and a later re-fire inserts a fresh pending row — which is
  // correct, that is a genuinely new showing rather than a continuation of this one.
  //
  // Suppression is unaffected by design: the resolved-fingerprint lookup above filters on
  // ("dismissed", "accepted") only, so an expired card is free to come back the moment its
  // rule fires again. That exclusion is load-bearing, not incidental.
  for (const sourceId of sourceIds) {
    const firedRuleIds = surviving
      .filter((f) => f.card.source.id === sourceId)
      .map((f) => f.card.ruleId);
    await db
      .update(recommendations)
      .set({ status: "expired", appliedAt: now })
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.source, sourceId),
          eq(recommendations.status, "pending"),
          firedRuleIds.length > 0 ? notInArray(recommendations.ruleId, firedRuleIds) : sql`true`,
        ),
      );
  }

  return { ids, fired: surviving.map((f) => f.card) };
}

/**
 * Runs the rules engine for `userId` and persists every rule that fired as its own
 * `recommendations` row (severity-tagged, so the UI can show the highest-severity one as
 * primary and the rest collapsed). Re-running for the same day replaces prior *pending*
 * rows for the same rule rather than piling up duplicates — accepted/dismissed history
 * is left alone.
 *
 * Sources are gathered per planSources() — the rules engine always, the model source in shadow
 * on ingestion events and in the rendered group when it is switched on for this athlete. Rendered
 * sources are arbitrated together so the one-card-per-run guarantee holds across them; each
 * shadow source is arbitrated alone, which is what makes it structurally unable to change what
 * the athlete sees.
 *
 * `ingestion: true` marks a real data-landing event (Whoop webhooks, the nightly sync) as opposed
 * to a passive dashboard read, and is what gates shadow evaluation. Kept separate from `notify`
 * below: they happen to be set at the same call sites today, but they answer different questions
 * and conflating them would make the digest gate mean two things.
 *
 * `notify: true` also fires the once-daily recovery digest email — reserve that for real
 * ingestion events (Whoop webhooks, the nightly safety-net sync), not passive dashboard
 * reads, or the "new data landed" gate stops meaning anything. The email itself still waits
 * for both today's recovery and sleep data to be present before sending.
 */
export async function generateRecommendations(
  userId: string,
  opts: { notify?: boolean; ingestion?: boolean } = {},
): Promise<string[]> {
  const snapshot = await buildRecoverySnapshot(userId);
  const timeZone = snapshot.timeZone ?? env.ATHLETE_TIMEZONE;
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + LOOKAHEAD_DAYS);

  const activePlanId = await getActivePlanId(userId);
  const upcoming = await db
    .select()
    .from(plannedRuns)
    .where(
      and(
        visibleRunsSql(userId, activePlanId),
        sql`${plannedRuns.scheduledAt} >= ${now}`,
        sql`${plannedRuns.scheduledAt} <= ${windowEnd}`,
      ),
    );

  let busyPeriods: Array<{ start: Date; end: Date }> = [];
  if (await hasGoogleConnection(userId)) {
    try {
      busyPeriods = await getPrimaryBusyPeriodsCached(
        userId,
        now.toISOString(),
        windowEnd.toISOString(),
        now,
      );
    } catch (err) {
      logger.warn({ err, userId }, "failed to fetch google busy periods for recommendations");
    }
  }

  // Read through the persisted table rather than refetched here. This used to make three NWS
  // calls plus a per-day upsert on every dashboard load; getForecastsForRules serves the stored
  // rows while they are recent, refreshes them when they aren't, and owns keeping the table
  // current for the calendar tab and the digest email — the job this block used to do.
  let weatherForecast: DailyForecast[] = [];
  const athleteLocation = await getAthleteLocation(userId);
  if (athleteLocation) {
    weatherForecast = await getForecastsForRules(
      userId,
      athleteLocation.lat,
      athleteLocation.lon,
      timeZone,
      LOOKAHEAD_DAYS,
      now,
    );
  }

  const thresholds = await getRuleThresholds(userId);
  const ctx: RuleContext = {
    snapshot,
    upcoming,
    busyPeriods,
    weatherForecast,
    timeZone,
    now,
    thresholds,
  };
  const plan = planSources({
    modelRendered: await isModelRenderedFor(userId),
    ingestion: opts.ingestion ?? false,
  });

  // Rendered sources are arbitrated *together*, so "at most one acceptable card per planned run"
  // holds across sources and not merely within one. Each shadow source is arbitrated over its own
  // outputs alone — that isolation is the entire point of shadow mode. Pooling them would let a
  // model card the athlete never sees claim a run and demote a rules card into an "Also noted:"
  // line, changing the visible output of an engine that is supposedly switched off.
  const rendered = await persistGroup({
    userId,
    snapshot,
    now,
    sourceIds: plan.rendered.map((s) => s.id),
    cards: await arbitrateGroup(plan.rendered, ctx, userId),
    ctx,
  });

  const ids = [...rendered.ids];
  for (const source of plan.shadow) {
    const group = await persistGroup({
      userId,
      snapshot,
      now,
      sourceIds: [source.id],
      cards: await arbitrateGroup([source], ctx, userId),
      ctx,
    });
    ids.push(...group.ids);
  }

  // Only the rendered group reaches the athlete — shadow cards are a scoring record, not mail.
  const fired = rendered.fired;

  if (opts.notify) {
    // Whoop delivers recovery.updated and sleep.updated as separate webhooks, each writing
    // only its own resource (see sync.ts) — buildRecoverySnapshot needs both. Wait for the
    // snapshot to actually be complete before sending, so the once-daily gate isn't burned on
    // half the data.
    const snapshotComplete = Boolean(snapshot.hasRecoveryToday && snapshot.hasSleepToday);
    if (snapshotComplete) {
      await maybeSendRecoveryDigest(userId, snapshot, fired);
    }
  }

  return ids;
}

/**
 * Best-effort regenerate for webhook / background callers. Never throws — callers
 * (Whoop webhooks especially) must still ACK even if the rules engine fails.
 */
export async function generateRecommendationsSafe(
  userId: string,
  opts: { notify?: boolean; ingestion?: boolean } = {},
): Promise<void> {
  try {
    const ids = await generateRecommendations(userId, opts);
    logger.info({ userId, count: ids.length }, "recommendations regenerated");
  } catch (err) {
    logger.error({ err, userId }, "failed to regenerate recommendations");
  }
}

const RUN_FIELD_APPLIERS: Record<string, (value: unknown) => Record<string, unknown>> = {
  runType: (v) => ({ runType: v }),
  targetPaceSPerKm: (v) => ({ targetPaceSPerKm: v }),
  durationMin: (v) => ({ durationMin: v }),
  distanceM: (v) => ({ distanceM: v }),
  scheduledAt: (v) => ({ scheduledAt: new Date(v as string) }),
};

export interface ApplyResult {
  applied: ProposedChange[];
  skipped: ProposedChange[];
}

/** Applies a recommendation's proposed_changes to planned_runs — skipping any whose target
 * run has changed since the card was generated — then pushes each touched run to Google
 * (a no-op if Google isn't connected). */
export async function applyProposedChanges(
  userId: string,
  changes: ProposedChange[],
): Promise<ApplyResult> {
  const runIds = [...new Set(changes.map((c) => c.plannedRunId))];
  const rows = runIds.length
    ? await db
        .select()
        .from(plannedRuns)
        .where(and(eq(plannedRuns.userId, userId), inArray(plannedRuns.id, runIds)))
    : [];
  const runsById = new Map(rows.map((r) => [r.id, r]));

  const applied: ProposedChange[] = [];
  const skipped: ProposedChange[] = [];
  const touchedRunIds = new Set<string>();

  for (const change of changes) {
    const applier = RUN_FIELD_APPLIERS[change.field];
    if (!applier) {
      logger.warn({ change }, "recommendation proposed an unknown field — skipping");
      skipped.push(change);
      continue;
    }
    if (isChangeStale(runsById.get(change.plannedRunId), change)) {
      logger.info({ userId, change }, "recommendation change is stale — skipping");
      skipped.push(change);
      continue;
    }
    await db
      .update(plannedRuns)
      .set({ ...applier(change.to), updatedAt: new Date() })
      .where(and(eq(plannedRuns.id, change.plannedRunId), eq(plannedRuns.userId, userId)));
    applied.push(change);
    touchedRunIds.add(change.plannedRunId);
  }

  for (const runId of touchedRunIds) {
    pushPlannedRunToGoogle(runId, userId).catch((err) =>
      logger.error({ err, runId }, "failed to push recommendation-modified run to google"),
    );
  }

  return { applied, skipped };
}
