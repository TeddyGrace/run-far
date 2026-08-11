import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { syncState } from "../../db/schema.js";
import { pullGoogleCalendarChanges } from "./pull.js";
import { logger } from "../../lib/logger.js";

/**
 * Google's push notifications carry no body — just headers identifying the channel and
 * resource. We look up which user owns that channel and trigger an incremental pull.
 * There's no signature to verify (channel id + our own record of it is the trust boundary).
 */
export async function googleWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/google", async (request, reply) => {
    const channelId = request.headers["x-goog-channel-id"];
    const resourceState = request.headers["x-goog-resource-state"];

    if (typeof channelId !== "string") {
      reply.status(400).send({ error: "missing channel id header" });
      return;
    }

    // "sync" is the handshake notification sent once when the channel is created — no
    // actual change to process.
    if (resourceState === "sync") {
      reply.status(200).send({ ok: true });
      return;
    }

    const [state] = await db
      .select({ userId: syncState.userId })
      .from(syncState)
      .where(and(eq(syncState.provider, "google"), eq(syncState.channelId, channelId)));

    if (!state) {
      logger.warn({ channelId }, "google webhook for unknown channel");
      reply.status(200).send({ ok: true }); // ack anyway; nothing we can do
      return;
    }

    try {
      await pullGoogleCalendarChanges(state.userId);
    } catch (err) {
      logger.error({ err, userId: state.userId }, "failed to process google webhook");
      reply.status(500).send({ error: "processing failed" });
      return;
    }

    reply.status(200).send({ ok: true });
  });
}
