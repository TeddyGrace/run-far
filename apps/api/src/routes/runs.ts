import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { createPlannedRunSchema, updatePlannedRunSchema } from "@run-far/shared";
import { db } from "../db/client.js";
import { plannedRuns } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { pushPlannedRunToGoogle, deletePlannedRunFromGoogle } from "../integrations/google/push.js";
import { logger } from "../lib/logger.js";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";

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
