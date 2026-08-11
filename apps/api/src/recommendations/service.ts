import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { plannedRuns, recommendations, oauthConnections } from "../db/schema.js";
import { buildRecoverySnapshot } from "./snapshot.js";
import { evaluate } from "./evaluate.js";
import { getPrimaryBusyPeriods } from "../integrations/google/calendarClient.js";
import { pushPlannedRunToGoogle } from "../integrations/google/push.js";
import { logger } from "../lib/logger.js";
import type { ProposedChange } from "@run-far/shared";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";

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
 */
export async function generateRecommendations(userId: string): Promise<string[]> {
  const snapshot = await buildRecoverySnapshot(userId);
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

  const { primary, secondary } = evaluate({ snapshot, upcoming, busyPeriods });
  const fired = [primary, ...secondary].filter((r): r is NonNullable<typeof primary> => r != null);

  const ids: string[] = [];
  for (const rule of fired) {
    await db
      .delete(recommendations)
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.date, snapshot.date),
          eq(recommendations.ruleId, rule.ruleId),
          eq(recommendations.status, "pending"),
        ),
      );
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
      })
      .returning({ id: recommendations.id });
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * Best-effort regenerate for webhook / background callers. Never throws — callers
 * (Whoop webhooks especially) must still ACK even if the rules engine fails.
 */
export async function generateRecommendationsSafe(userId: string): Promise<void> {
  try {
    const ids = await generateRecommendations(userId);
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
