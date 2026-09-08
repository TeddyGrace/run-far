import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { recommendations } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { generateRecommendationsSafe, applyProposedChanges } from "../recommendations/service.js";
import { proposedChangeSchema } from "@run-far/shared";
import { renderedSourceIdsFor } from "../lib/modelRendering.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

export async function recommendationRoutes(app: FastifyInstance) {
  app.get("/api/recommendations", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    // Best-effort: a Google API hiccup should surface cached recommendations, not a 500.
    await generateRecommendationsSafe(userId);

    // Shadow-source rows are persisted for scoring but never shown. Filtering here (rather than
    // not writing them) is what lets a candidate model be evaluated against real accept/dismiss
    // behavior while it is still switched off.
    const rows = await db
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.status, "pending"),
          inArray(recommendations.source, await renderedSourceIdsFor(userId)),
        ),
      )
      // `rank` is the priority order the rules engine decided (0 = primary). Ordering by
      // createdAt alone, as this used to, returned the engine's ordering reversed — the
      // lowest-severity note ended up as the dashboard's headline card.
      .orderBy(asc(recommendations.rank), desc(recommendations.createdAt));

    // This route is the only place a card is actually rendered to the athlete, so it is the only
    // place that can record it was. Without this, "never seen" and "seen and ignored" are the
    // same row — which is precisely what makes an expired card uninterpretable as training data:
    // one is not an example at all, the other is a real negative.
    //
    // The IS NULL guard makes it first-shown rather than last-shown, so it stamps once and later
    // reads leave it alone. Awaited so the write is durable before the response, but wrapped:
    // a failure to stamp is a lost training signal, never a reason to fail a dashboard read.
    // The response deliberately carries the pre-stamp value; nothing consumes it.
    if (rows.length > 0) {
      try {
        await db
          .update(recommendations)
          .set({ firstShownAt: new Date() })
          .where(
            and(
              eq(recommendations.userId, userId),
              inArray(
                recommendations.id,
                rows.map((r) => r.id),
              ),
              isNull(recommendations.firstShownAt),
            ),
          );
      } catch (err) {
        logger.warn({ err, userId }, "failed to stamp first_shown_at on recommendations");
      }
    }

    return rows;
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
    // A shadow row is not part of this athlete's plan — it records what a source *would* have
    // suggested. Applying one would let an engine that is switched off edit real sessions, so it
    // is indistinguishable from a nonexistent card here, not merely hidden from the list.
    if (!(await renderedSourceIdsFor(userId)).includes(rec.source)) {
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
      // Recorded as `stale`, not `dismissed`. The athlete did try to accept this card — the run
      // had simply moved on first. Collapsing the two into one status taught anything trained on
      // this column to avoid suggestions that were merely late, which is the opposite of the
      // signal. The 409 below is unchanged, so the SPA sees no difference.
      await db
        .update(recommendations)
        .set({ status: "stale", appliedAt: new Date() })
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
      .select({
        id: recommendations.id,
        status: recommendations.status,
        source: recommendations.source,
      })
      .from(recommendations)
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
    if (!rec) {
      reply.status(404).send({ error: { message: "Recommendation not found", code: "NOT_FOUND" } });
      return;
    }
    // See the accept handler — a shadow row is not addressable, in either direction. Dismissing
    // one would also corrupt its own scoring record by writing an athlete verdict on a card the
    // athlete was never shown.
    if (!(await renderedSourceIdsFor(userId)).includes(rec.source)) {
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
