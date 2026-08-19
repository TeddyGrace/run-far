import { and, eq, sql, inArray, notInArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { plannedRuns, recommendations, oauthConnections, weatherForecasts } from "../db/schema.js";
import { buildRecoverySnapshot } from "./snapshot.js";
import { evaluate } from "./evaluate.js";
import { fingerprintOf } from "./fingerprint.js";
import { getPrimaryBusyPeriods } from "../integrations/google/calendarClient.js";
import { getDailyForecasts } from "../integrations/weather/weatherClient.js";
import { getAthleteLocation } from "../lib/athleteLocation.js";
import { pushPlannedRunToGoogle } from "../integrations/google/push.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";
import type { ProposedChange } from "@run-far/shared";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";
import { maybeSendRecoveryDigest } from "../integrations/google/recoveryDigest.js";

const LOOKAHEAD_DAYS = 10;

async function hasGoogleConnection(userId: string): Promise<boolean> {
  const [conn] = await db
    .select({ id: oauthConnections.id })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
  return Boolean(conn);
}

/**
 * Runs the rules engine for `userId` and persists every rule that fired as its own
 * `recommendations` row (severity-tagged, so the UI can show the highest-severity one as
 * primary and the rest collapsed). Re-running for the same day replaces prior *pending*
 * rows for the same rule rather than piling up duplicates — accepted/dismissed history
 * is left alone.
 *
 * `notify: true` also fires the once-daily recovery digest email — reserve that for real
 * ingestion events (Whoop webhooks, the nightly safety-net sync), not passive dashboard
 * reads, or the "new data landed" gate stops meaning anything. The email itself still waits
 * for both today's recovery and sleep data to be present before sending.
 */
export async function generateRecommendations(
  userId: string,
  opts: { notify?: boolean } = {},
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
      busyPeriods = await getPrimaryBusyPeriods(userId, now.toISOString(), windowEnd.toISOString());
    } catch (err) {
      logger.warn({ err, userId }, "failed to fetch google busy periods for recommendations");
    }
  }

  // Refreshed on every call (dashboard read, webhook, nightly sync) — this upsert is what
  // keeps the persisted table, and therefore the calendar tab's forecast display, current.
  let weatherForecast: Awaited<ReturnType<typeof getDailyForecasts>> = [];
  const athleteLocation = await getAthleteLocation(userId);
  if (athleteLocation) {
    try {
      weatherForecast = await getDailyForecasts(
        athleteLocation.lat,
        athleteLocation.lon,
        timeZone,
        LOOKAHEAD_DAYS,
      );
      for (const day of weatherForecast) {
        const values = {
          userId,
          date: day.date,
          highTempF: day.highTempF,
          lowTempF: day.lowTempF,
          shortForecast: day.shortForecast,
          precipProbabilityPct: day.precipProbabilityPct,
          windSpeed: day.windSpeed,
          windDirection: day.windDirection,
          iconUrl: day.iconUrl,
          iconCode: day.iconCode,
          hourly: day.hourly,
          segments: day.segments,
          alerts: day.alerts,
          fetchedAt: new Date(),
        };
        await db
          .insert(weatherForecasts)
          .values(values)
          .onConflictDoUpdate({
            target: [weatherForecasts.userId, weatherForecasts.date],
            set: { ...values, updatedAt: new Date() },
          });
      }
    } catch (err) {
      logger.warn({ err, userId }, "failed to fetch NWS weather for recommendations");
    }
  }

  const { primary, secondary } = evaluate({
    snapshot,
    upcoming,
    busyPeriods,
    weatherForecast,
    timeZone,
  });
  const allFired = [primary, ...secondary].filter((r): r is NonNullable<typeof primary> => r != null);

  // Suppress rules whose content the athlete has already resolved (dismissed or accepted) —
  // otherwise every regeneration (dashboard read, webhook, nightly sync) reinserts an
  // identical card the instant the resolved row leaves the pending-only unique index.
  // Fingerprint excludes `date`, so this holds even after the day rolls over.
  const fingerprinted = allFired.map((rule) => ({ rule, fingerprint: fingerprintOf(rule) }));
  const resolvedFingerprints = fingerprinted.length
    ? new Set(
        (
          await db
            .select({ fingerprint: recommendations.fingerprint })
            .from(recommendations)
            .where(
              and(
                eq(recommendations.userId, userId),
                inArray(recommendations.status, ["dismissed", "accepted"]),
                inArray(
                  recommendations.fingerprint,
                  fingerprinted.map((f) => f.fingerprint),
                ),
              ),
            )
        ).map((r) => r.fingerprint),
      )
    : new Set<string>();

  const fired = fingerprinted.filter((f) => !resolvedFingerprints.has(f.fingerprint)).map((f) => f.rule);

  const ids: string[] = [];
  for (const { rule, fingerprint } of fingerprinted) {
    if (resolvedFingerprints.has(fingerprint)) continue;
    // Upsert against the partial unique index (user, date, ruleId) WHERE status='pending' —
    // atomic under concurrency, unlike the delete-then-insert this replaced, which let two
    // regenerations racing for the same user (a webhook and a dashboard read, or two paired
    // webhooks) each insert their own row for the same rule/day.
    const [row] = await db
      .insert(recommendations)
      .values({
        userId,
        date: snapshot.date,
        ruleId: rule.ruleId,
        severity: rule.severity,
        summary: rule.summary,
        reason: rule.reason,
        inputSnapshot: snapshot,
        proposedChanges: rule.proposedChanges,
        status: "pending",
        fingerprint,
      })
      .onConflictDoUpdate({
        target: [recommendations.userId, recommendations.date, recommendations.ruleId],
        targetWhere: eq(recommendations.status, "pending"),
        set: {
          severity: rule.severity,
          summary: rule.summary,
          reason: rule.reason,
          inputSnapshot: snapshot,
          proposedChanges: rule.proposedChanges,
          fingerprint,
          createdAt: new Date(),
        },
      })
      .returning({ id: recommendations.id });
    if (row) ids.push(row.id);
  }

  // Retract any pending row for a rule that no longer fires today — otherwise a resolved
  // situation (conflict rescheduled away, recovery back in range) leaves a stale card on
  // screen forever, since nothing else ever deletes a pending row.
  const firedRuleIds = fired.map((r) => r.ruleId);
  await db
    .delete(recommendations)
    .where(
      and(
        eq(recommendations.userId, userId),
        eq(recommendations.date, snapshot.date),
        eq(recommendations.status, "pending"),
        firedRuleIds.length > 0 ? notInArray(recommendations.ruleId, firedRuleIds) : sql`true`,
      ),
    );

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
  opts: { notify?: boolean } = {},
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

/** Applies a recommendation's proposed_changes to planned_runs, then pushes each touched
 * run to Google (a no-op if Google isn't connected). */
export async function applyProposedChanges(
  userId: string,
  changes: ProposedChange[],
): Promise<void> {
  const touchedRunIds = new Set<string>();
  for (const change of changes) {
    const applier = RUN_FIELD_APPLIERS[change.field];
    if (!applier) {
      logger.warn({ change }, "recommendation proposed an unknown field — skipping");
      continue;
    }
    await db
      .update(plannedRuns)
      .set({ ...applier(change.to), updatedAt: new Date() })
      .where(and(eq(plannedRuns.id, change.plannedRunId), eq(plannedRuns.userId, userId)));
    touchedRunIds.add(change.plannedRunId);
  }
  for (const runId of touchedRunIds) {
    pushPlannedRunToGoogle(runId, userId).catch((err) =>
      logger.error({ err, runId }, "failed to push recommendation-modified run to google"),
    );
  }
}
