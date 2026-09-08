import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { recommendations } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { generateRecommendationsSafe, applyProposedChanges } from "../recommendations/service.js";
import { proposedChangeSchema } from "@run-far/shared";
import { z } from "zod";

export async function recommendationRoutes(app: FastifyInstance) {
  app.get("/api/recommendations", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    // Best-effort: a Google API hiccup should surface cached recommendations, not a 500.
    await generateRecommendationsSafe(userId);

    return db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")))
      // `rank` is the priority order the rules engine decided (0 = primary). Ordering by
      // createdAt alone, as this used to, returned the engine's ordering reversed — the
      // lowest-severity note ended up as the dashboard's headline card.
      .orderBy(asc(recommendations.rank), desc(recommendations.createdAt));
  });

  app.post("/api/recommendations/:id/accept", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    const [rec] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
    if (!rec) {
      reply.status(404).send({ error: { message: "Recommendation not found", code: "NOT_FOUND" } });
      return;
    }
    if (rec.status !== "pending") {
      reply.status(409).send({ error: { message: "Recommendation already resolved", code: "ALREADY_RESOLVED" } });
      return;
    }

    const changes = z.array(proposedChangeSchema).parse(rec.proposedChanges);
    const { applied, skipped } = await applyProposedChanges(userId, changes);

    // Every change was against a run that has since moved on — the card is describing a plan
    // that no longer exists, so resolve it without pretending anything was applied. The next
    // regeneration will mint a fresh card against the run's current state.
    if (applied.length === 0 && skipped.length > 0) {
      await db
        .update(recommendations)
        .set({ status: "dismissed", appliedAt: new Date() })
        .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
      reply.status(409).send({
        error: {
          message: "This suggestion is out of date — the run has changed since it was generated.",
          code: "STALE_RECOMMENDATION",
        },
      });
      return;
    }

    await db
      .update(recommendations)
      .set({ status: "accepted", appliedAt: new Date() })
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));

    const [updated] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
    return updated;
  });

  app.post("/api/recommendations/:id/dismiss", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    const [rec] = await db
      .select({ id: recommendations.id, status: recommendations.status })
      .from(recommendations)
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
    if (!rec) {
      reply.status(404).send({ error: { message: "Recommendation not found", code: "NOT_FOUND" } });
      return;
    }
    if (rec.status !== "pending") {
      reply.status(409).send({ error: { message: "Recommendation already resolved", code: "ALREADY_RESOLVED" } });
      return;
    }

    await db
      .update(recommendations)
      .set({ status: "dismissed", appliedAt: new Date() })
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));

    const [updated] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
    return updated;
  });
}
