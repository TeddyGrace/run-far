import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { plannedRuns, trainingPlans } from "../db/schema.js";
import {
  deletePlannedRunFromGoogle,
  hasGoogleConnection,
  pushPlannedRunToGoogle,
} from "../integrations/google/push.js";
import { isInvalidGrant } from "../integrations/google/oauth.js";
import { logger } from "../lib/logger.js";

export async function getActivePlanId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: trainingPlans.id })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.status, "active")));
  return row?.id ?? null;
}

/** SQL fragment: runs belonging to the active plan, or ad-hoc manual runs. */
export function visibleRunsSql(userId: string, activePlanId: string | null) {
  if (activePlanId) {
    return sql`(
      ${plannedRuns.userId} = ${userId}
      AND (
        ${plannedRuns.planId} = ${activePlanId}
        OR (${plannedRuns.planId} IS NULL AND ${plannedRuns.origin} = 'manual')
      )
    )`;
  }
  return sql`(
    ${plannedRuns.userId} = ${userId}
    AND ${plannedRuns.planId} IS NULL
    AND ${plannedRuns.origin} = 'manual'
  )`;
}

/** Remove Google Calendar events for every run on this plan and clear local gcal ids. */
export async function deactivatePlan(userId: string, planId: string): Promise<void> {
  const runs = await db
    .select({ id: plannedRuns.id, gcalEventId: plannedRuns.gcalEventId })
    .from(plannedRuns)
    .where(and(eq(plannedRuns.userId, userId), eq(plannedRuns.planId, planId)));

  for (const run of runs) {
    if (run.gcalEventId) {
      try {
        await deletePlannedRunFromGoogle(run.gcalEventId, userId);
      } catch (err) {
        logger.error({ err, runId: run.id, planId }, "failed to delete plan run from google on deactivate");
      }
    }
  }

  if (runs.length > 0) {
    await db
      .update(plannedRuns)
      .set({ gcalEventId: null, gcalEtag: null, updatedAt: new Date() })
      .where(and(eq(plannedRuns.userId, userId), eq(plannedRuns.planId, planId)));
  }

  await db
    .update(trainingPlans)
    .set({ status: "inactive" })
    .where(
      and(
        eq(trainingPlans.id, planId),
        eq(trainingPlans.userId, userId),
        eq(trainingPlans.status, "active"),
      ),
    );
}

/**
 * Make `planId` the sole active plan for this user: deactivate the previous active
 * plan (including GCal cleanup), then push this plan's runs to Google.
 */
export async function activatePlan(userId: string, planId: string): Promise<void> {
  const [plan] = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
  if (!plan) throw new Error("PLAN_NOT_FOUND");
  if (plan.status === "archived") throw new Error("PLAN_ARCHIVED");

  const currentActiveId = await getActivePlanId(userId);
  if (currentActiveId && currentActiveId !== planId) {
    await deactivatePlan(userId, currentActiveId);
  }

  await db
    .update(trainingPlans)
    .set({ status: "active", archivedAt: null })
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));

  const runs = await db
    .select({ id: plannedRuns.id })
    .from(plannedRuns)
    .where(and(eq(plannedRuns.userId, userId), eq(plannedRuns.planId, planId)));

  for (const run of runs) {
    pushPlannedRunToGoogle(run.id, userId).catch((err) =>
      logger.error({ err, runId: run.id, planId }, "failed to push activated plan run to google"),
    );
  }
}

/**
 * Re-pushes every run on this plan to Google Calendar so it matches the app's current
 * state — fixes drift from manual edits on the Google side or events missed by past bugs
 * (e.g. rest days that were synced before that filter existed).
 */
export async function resyncPlanToGoogle(
  userId: string,
  planId: string,
): Promise<{ synced: number; failed: number }> {
  const [plan] = await db
    .select({ id: trainingPlans.id })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
  if (!plan) throw new Error("PLAN_NOT_FOUND");

  if (!(await hasGoogleConnection(userId))) throw new Error("GOOGLE_NOT_CONNECTED");

  const runs = await db
    .select({ id: plannedRuns.id })
    .from(plannedRuns)
    .where(and(eq(plannedRuns.userId, userId), eq(plannedRuns.planId, planId)));

  let synced = 0;
  let failed = 0;
  for (const run of runs) {
    try {
      await pushPlannedRunToGoogle(run.id, userId);
      synced++;
    } catch (err) {
      // A dead refresh token fails every remaining run identically — getAuthedClient has
      // already flagged the connection needs-reauth, so stop and surface that distinctly
      // instead of grinding out N identical failures and reporting an opaque failed count.
      if (isInvalidGrant(err)) throw new Error("GOOGLE_NEEDS_REAUTH");
      failed++;
      logger.error({ err, runId: run.id, planId }, "failed to resync plan run to google");
    }
  }

  return { synced, failed };
}

export async function archivePlan(userId: string, planId: string): Promise<void> {
  const [plan] = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
  if (!plan) throw new Error("PLAN_NOT_FOUND");
  if (plan.status === "archived") return;

  if (plan.status === "active") {
    await deactivatePlan(userId, planId);
  }

  await db
    .update(trainingPlans)
    .set({ status: "archived", archivedAt: new Date() })
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
}

export async function unarchivePlan(userId: string, planId: string): Promise<void> {
  const [plan] = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
  if (!plan) throw new Error("PLAN_NOT_FOUND");
  if (plan.status !== "archived") return;

  await db
    .update(trainingPlans)
    .set({ status: "inactive", archivedAt: null })
    .where(and(eq(trainingPlans.id, planId), eq(trainingPlans.userId, userId)));
}
