import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { createPlannedRunSchema, setRunActualSchema, updatePlannedRunSchema } from "@run-far/shared";
import { z } from "zod";
import { db } from "../db/client.js";
import { plannedRuns, workouts } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { pushPlannedRunToGoogle, deletePlannedRunFromGoogle } from "../integrations/google/push.js";
import { logger } from "../lib/logger.js";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";
import { buildAdherence } from "../reconciliation/adherence.js";
import { reconcileUserSafe } from "../reconciliation/service.js";
import { getActiveHealthProvider, providerFilter } from "../lib/healthProvider.js";

const adherenceQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(28),
});

/**
 * Last time a reconciliation sweep ran for a user on this instance.
 *
 * The adherence read regenerates before it reports, so a dashboard is never showing a week-old
 * verdict just because a webhook was dropped. Unlike the recommendations route's regeneration,
 * this one makes no third-party calls — it is three queries and a small transaction — but it is
 * still throttled, because a dashboard that polls has no need to re-decide the same fortnight
 * every few seconds. Process-local and best-effort by design: the worst case of a cold instance
 * is one extra sweep, and the nightly job and Whoop webhooks are what actually guarantee
 * freshness.
 */
const lastSweepAt = new Map<string, number>();
const SWEEP_THROTTLE_MS = 60_000;

async function reconcileThrottled(userId: string): Promise<void> {
  const last = lastSweepAt.get(userId) ?? 0;
  if (Date.now() - last < SWEEP_THROTTLE_MS) return;
  lastSweepAt.set(userId, Date.now());
  await reconcileUserSafe(userId);
}

export async function runRoutes(app: FastifyInstance) {
  app.get("/api/runs", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { from, to } = request.query as { from?: string; to?: string };

    const activePlanId = await getActivePlanId(userId);
    const conditions = [visibleRunsSql(userId, activePlanId)];
    if (from) conditions.push(sql`${plannedRuns.scheduledAt} >= ${new Date(from)}`);
    if (to) conditions.push(sql`${plannedRuns.scheduledAt} <= ${new Date(to)}`);

    return db
      .select()
      .from(plannedRuns)
      .where(and(...conditions))
      .orderBy(plannedRuns.scheduledAt);
  });

  /** Planned vs actual for a recent window: what the plan asked for, what Whoop recorded, and
   * which runs the sweep could not account for. */
  app.get("/api/runs/adherence", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { days } = adherenceQuerySchema.parse(request.query);

    await reconcileThrottled(userId);
    return buildAdherence(userId, { windowDays: days });
  });

  /**
   * Athlete correction of a match the sweep got wrong — link a different workout, or say a run
   * was skipped after all.
   *
   * Separate from the general PATCH because it means something the general one doesn't: it
   * stamps the run `manual`, which takes it out of the sweep's hands permanently. Folding that
   * into a plain status edit would make every incidental status change a silent opt-out of
   * reconciliation.
   */
  app.patch("/api/runs/:id/actual", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const body = setRunActualSchema.parse(request.body);

    const [existing] = await db
      .select({ id: plannedRuns.id })
      .from(plannedRuns)
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));
    if (!existing) {
      reply.status(404).send({ error: { message: "Run not found", code: "NOT_FOUND" } });
      return;
    }

    if (body.workoutId) {
      // Scoped to the active provider as well as the athlete: linking a run to a workout from
      // the wearable the engine no longer reads would leave the run `completed` with an
      // "actual" that nothing downstream — adherence, the assistant, the dashboard — can see.
      const provider = await getActiveHealthProvider(userId);
      const [workout] = await db
        .select({ id: workouts.id })
        .from(workouts)
        .where(and(providerFilter.workouts(userId, provider), eq(workouts.id, body.workoutId)));
      if (!workout) {
        reply.status(404).send({ error: { message: "Workout not found", code: "NOT_FOUND" } });
        return;
      }

      // One workout satisfies one run: releasing it from whichever run currently holds it is
      // part of assigning it here, not a separate step the caller has to remember. Without
      // this the partial unique index rejects the correction outright.
      await db
        .update(plannedRuns)
        .set({ actualWorkoutId: null, status: "planned", matchSource: null, reconciledAt: null })
        .where(
          and(
            eq(plannedRuns.userId, userId),
            eq(plannedRuns.actualWorkoutId, body.workoutId),
            sql`${plannedRuns.id} <> ${id}`,
          ),
        );
    }

    await db
      .update(plannedRuns)
      .set({
        actualWorkoutId: body.workoutId,
        status: body.workoutId ? "completed" : (body.status ?? "planned"),
        matchSource: "manual",
        reconciledAt: new Date(),
      })
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));

    const [updated] = await db
      .select()
      .from(plannedRuns)
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));
    return updated;
  });

  app.post("/api/runs", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const body = createPlannedRunSchema.parse(request.body);

    const [run] = await db
      .insert(plannedRuns)
      .values({
        ...body,
        userId,
        planId: body.planId ?? null,
        origin: body.origin ?? "manual",
        scheduledAt: new Date(body.scheduledAt),
      })
      .returning();
    if (!run) throw new Error("failed to create planned run");

    pushPlannedRunToGoogle(run.id, userId).catch((err) =>
      logger.error({ err, runId: run.id }, "failed to push new run to google"),
    );
    return run;
  });

  app.patch("/api/runs/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const body = updatePlannedRunSchema.parse(request.body);

    const [existing] = await db
      .select({ id: plannedRuns.id })
      .from(plannedRuns)
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));
    if (!existing) {
      reply.status(404).send({ error: { message: "Run not found", code: "NOT_FOUND" } });
      return;
    }

    const { scheduledAt, ...rest } = body;
    await db
      .update(plannedRuns)
      .set({
        ...rest,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));

    pushPlannedRunToGoogle(id, userId).catch((err) =>
      logger.error({ err, runId: id }, "failed to push updated run to google"),
    );
    const [updated] = await db
      .select()
      .from(plannedRuns)
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));
    return updated;
  });

  app.delete("/api/runs/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    const [existing] = await db
      .select()
      .from(plannedRuns)
      .where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));
    if (!existing) {
      reply.status(404).send({ error: { message: "Run not found", code: "NOT_FOUND" } });
      return;
    }

    await db.delete(plannedRuns).where(and(eq(plannedRuns.id, id), eq(plannedRuns.userId, userId)));
    deletePlannedRunFromGoogle(existing.gcalEventId, userId).catch((err) =>
      logger.error({ err, runId: id }, "failed to delete run from google"),
    );
    return { ok: true };
  });
}
