import type { FastifyInstance, FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { processedWebhookEvents } from "../../db/schema.js";
import { isStripeConfigured, stripeClient } from "./client.js";
import { applyStripeSubscription } from "./entitlement.js";

const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

export async function stripeWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/stripe", async (request: FastifyRequest, reply) => {
    if (!isStripeConfigured()) {
      reply.status(503).send({ error: "stripe not configured" });
      return;
    }

    const signature = request.headers["stripe-signature"];
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
    if (typeof signature !== "string" || !rawBody) {
      reply.status(400).send({ error: "missing signature or body" });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripeClient().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logger.warn({ err }, "stripe webhook signature verification failed");
      reply.status(400).send({ error: "invalid signature" });
      return;
    }

    // Idempotency: insert the event id before doing anything else. A conflict means this
    // exact event was already processed (Stripe retries on anything but a 2xx) — ack without
    // reprocessing rather than risk double-applying a state change.
    const [inserted] = await db
      .insert(processedWebhookEvents)
      .values({ id: event.id, provider: "stripe" })
      .onConflictDoNothing()
      .returning({ id: processedWebhookEvents.id });
    if (!inserted) {
      reply.status(200).send({ ok: true, deduped: true });
      return;
    }

    if (!HANDLED_EVENT_TYPES.has(event.type)) {
      reply.status(200).send({ ok: true });
      return;
    }

    try {
      await handleEvent(event);
    } catch (err) {
      // Release the idempotency claim before asking Stripe to retry. Without this the retry
      // would hit the onConflictDoNothing above, be acked as a duplicate, and the event would
      // be dropped for good — i.e. a transient failure here would leave a paying athlete
      // permanently unentitled.
      await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.id, event.id));
      logger.error({ err, eventType: event.type, eventId: event.id }, "failed to process stripe webhook");
      reply.status(500).send({ error: "processing failed" });
      return;
    }

    reply.status(200).send({ ok: true });
  });
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  const eventCreated = new Date(event.created * 1000);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (typeof session.subscription !== "string") {
        // A non-subscription Checkout session (shouldn't happen — routes/billing.ts always
        // creates mode: "subscription") has nothing for us to apply.
        return;
      }
      // Fetch the full subscription rather than waiting on the separate
      // customer.subscription.created event, so entitlement is live the moment the athlete
      // lands back on the success page regardless of event delivery order.
      const subscription = await stripeClient().subscriptions.retrieve(session.subscription);
      await applyStripeSubscription(subscription, eventCreated);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await applyStripeSubscription(event.data.object, eventCreated);
      return;
    }
    case "invoice.payment_failed": {
      // No direct write here: Stripe also fires customer.subscription.updated with the
      // subscription's new status (typically past_due) around a failed invoice, and that's
      // the event applyStripeSubscription actually acts on. This case exists so a failed
      // payment is visible in logs even if that follow-up event is ever missed.
      logger.warn({ invoiceId: event.data.object.id }, "stripe invoice payment failed");
      return;
    }
  }
}
