import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { oauthConnections, recoveryMetrics, sleepRecords, workouts } from "../../db/schema.js";
import { syncSingleResource } from "./sync.js";
import { generateRecommendationsSafe } from "../../recommendations/service.js";
import { reconcileUserSafe } from "../../reconciliation/service.js";
import { logger } from "../../lib/logger.js";
import type { WhoopWebhookPayload } from "./types.js";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // reject webhooks with a stale timestamp

export function verifySignature(rawBody: string, timestamp: string, signature: string): boolean {
  const expected = createHmac("sha256", env.WHOOP_WEBHOOK_SECRET)
    .update(timestamp + rawBody)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

async function findUserIdForWhoopUser(whoopUserId: number): Promise<string | null> {
  // Metadata stores the whoop user id captured at connect time so webhooks (which only carry
  // the Whoop-side id) can be routed to the right app user — see the jsonb index in db/schema.ts.
  const [conn] = await db
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.provider, "whoop"),
        sql`${oauthConnections.metadata}->>'whoopUserId' = ${String(whoopUserId)}`,
      ),
    );
  return conn?.userId ?? null;
}

export async function whoopWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/whoop", async (request: FastifyRequest, reply) => {
      const signature = request.headers["x-whoop-signature"];
      const timestamp = request.headers["x-whoop-signature-timestamp"];
      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;

      if (typeof signature !== "string" || typeof timestamp !== "string" || !rawBody) {
        reply.status(400).send({ error: "missing signature headers or body" });
        return;
      }

      const skew = Math.abs(Date.now() - Number(timestamp));
      if (!Number.isFinite(skew) || skew > MAX_CLOCK_SKEW_MS) {
        reply.status(401).send({ error: "stale or invalid timestamp" });
        return;
      }

      if (!verifySignature(rawBody, timestamp, signature)) {
        logger.warn("whoop webhook signature verification failed");
        reply.status(401).send({ error: "invalid signature" });
        return;
      }

      const payload = JSON.parse(rawBody) as WhoopWebhookPayload;
      const userId = await findUserIdForWhoopUser(payload.user_id);
      if (!userId) {
        // Ack anyway — nothing we can do, and Whoop will retry on non-2xx.
        logger.warn({ whoopUserId: payload.user_id }, "webhook for unknown whoop user");
        reply.status(200).send({ ok: true });
        return;
      }

      try {
        await handleEvent(userId, payload);
      } catch (err) {
        logger.error({ err, payload }, "failed to process whoop webhook");
        reply.status(500).send({ error: "processing failed" });
        return;
      }

      reply.status(200).send({ ok: true });
  });
}

async function handleEvent(userId: string, payload: WhoopWebhookPayload): Promise<void> {
  const id = String(payload.id);
  // No cycle.updated/cycle.deleted event exists in Whoop's webhook model — cycles are kept
  // fresh by syncSingleResource piggybacking a cycle refresh onto the sleep/recovery cases
  // below (both reference a cycle_id), plus the nightly full-range safety net.
  switch (payload.type) {
    case "recovery.updated":
      // Recovery score/HRV land here — regenerate so red/yellow/green rules see fresh data.
      // notify: true — this is real ingestion, so it's eligible to trigger today's digest
      // email, but generateRecommendations only actually sends once today's recovery AND
      // sleep rows are both present (see service.ts) — recovery.updated and sleep.updated
      // arrive as separate webhooks, each writing only its own resource (sync.ts), so
      // whichever one completes the pair is the one that triggers the send. Regeneration
      // itself is upserted against a per-(user,date,rule) unique index, so even if both
      // webhooks race each other here, they can't produce duplicate rows or duplicate emails.
      await syncSingleResource(userId, "recovery", id);
      await generateRecommendationsSafe(userId, { notify: true, ingestion: true });
      return;
    case "recovery.deleted":
      await db
        .delete(recoveryMetrics)
        .where(
          and(
            eq(recoveryMetrics.userId, userId),
            // A Whoop webhook can only ever delete a Whoop row. Without this the id
            // match alone would be free to hit an apple_health row.
            eq(recoveryMetrics.provider, "whoop"),
            eq(recoveryMetrics.externalId, id),
          ),
        );
      return;
    case "sleep.updated":
      // Morning sleep sync is the primary cue to refresh today's recommendation.
      await syncSingleResource(userId, "sleep", id);
      await generateRecommendationsSafe(userId, { notify: true, ingestion: true });
      return;
    case "sleep.deleted":
      await db
        .delete(sleepRecords)
        .where(
          and(
            eq(sleepRecords.userId, userId),
            // A Whoop webhook can only ever delete a Whoop row. Without this the id
            // match alone would be free to hit an apple_health row.
            eq(sleepRecords.provider, "whoop"),
            eq(sleepRecords.externalId, id),
          ),
        );
      return;
    case "workout.updated":
      // A workout landing is the only event that can turn a planned run into a completed one,
      // so it is the natural trigger for reconciliation. Also covers re-scoring: Whoop sends
      // this again when it finishes computing strain or backfills a GPS distance, and the sweep
      // re-derives from current data rather than trusting its earlier guess.
      await syncSingleResource(userId, "workout", id);
      await reconcileUserSafe(userId);
      return;
    case "workout.deleted":
      await db
        .delete(workouts)
        .where(
          and(
            eq(workouts.userId, userId),
            // A Whoop webhook can only ever delete a Whoop row. Without this the id
            // match alone would be free to hit an apple_health row.
            eq(workouts.provider, "whoop"),
            eq(workouts.externalId, id),
          ),
        );
      // The FK clears the link on its own (ON DELETE SET NULL), but that leaves the run sitting
      // at 'completed' with nothing behind it — a deleted workout has to be able to un-complete
      // a run, or adherence permanently overstates what was done.
      await reconcileUserSafe(userId);
      return;
  }
}
