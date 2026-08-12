import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { oauthConnections, recoveryMetrics, sleepRecords, whoopWorkouts } from "../../db/schema.js";
import { syncSingleResource } from "./sync.js";
import { generateRecommendationsSafe } from "../../recommendations/service.js";
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
  // We only track one Whoop connection per app user; metadata stores the whoop user id
  // captured at connect time so webhooks (which only carry the Whoop-side id) can be routed.
  const [conn] = await db
    .select()
    .from(oauthConnections)
    .where(eq(oauthConnections.provider, "whoop"));
  if (!conn) return null;
  const meta = conn.metadata as { whoopUserId?: number } | null;
  if (meta?.whoopUserId !== whoopUserId) return null;
  return conn.userId;
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
  switch (payload.type) {
    case "recovery.updated":
      // Recovery score/HRV land here — regenerate so red/yellow/green rules see fresh data.
      // notify: true — this is real ingestion, so it's eligible to trigger today's digest email.
      await syncSingleResource(userId, "recovery", id);
      await generateRecommendationsSafe(userId, { notify: true });
      return;
    case "recovery.deleted":
      await db.delete(recoveryMetrics).where(eq(recoveryMetrics.whoopSleepId, id));
      return;
    case "sleep.updated":
      // Morning sleep sync is the primary cue to refresh today's recommendation.
      await syncSingleResource(userId, "sleep", id);
      await generateRecommendationsSafe(userId, { notify: true });
      return;
    case "sleep.deleted":
      await db.delete(sleepRecords).where(eq(sleepRecords.whoopSleepId, id));
      return;
    case "workout.updated":
      await syncSingleResource(userId, "workout", id);
      return;
    case "workout.deleted":
      await db.delete(whoopWorkouts).where(eq(whoopWorkouts.whoopWorkoutId, id));
      return;
  }
}
