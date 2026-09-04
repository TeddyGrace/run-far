import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.STRIPE_SECRET_KEY ??= "sk_test_not_a_real_key";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_not_a_real_secret";

const { db } = await import("../../db/client.js");
const { users, processedWebhookEvents } = await import("../../db/schema.js");
const { buildServer } = await import("../../server.js");
const { inArray, eq } = await import("drizzle-orm");
const { stripeClient } = await import("./client.js");
const { env } = await import("../../env.js");

function signedPayload(payload: object) {
  const body = JSON.stringify(payload);
  const signature = stripeClient().webhooks.generateTestHeaderString({
    payload: body,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  return { body, signature };
}

function subscriptionUpdatedEvent(customerId: string, eventId: string) {
  return {
    id: eventId,
    object: "event",
    type: "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `sub_${randomUUID()}`,
        object: "subscription",
        customer: customerId,
        status: "active",
        metadata: {},
        items: {
          object: "list",
          data: [
            {
              id: `si_${randomUUID()}`,
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            },
          ],
        },
      },
    },
  };
}

describe("POST /webhooks/stripe", () => {
  let createdUserIds: string[] = [];
  let createdEventIds: string[] = [];

  afterEach(async () => {
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
    if (createdEventIds.length) {
      await db.delete(processedWebhookEvents).where(inArray(processedWebhookEvents.id, createdEventIds));
    }
    createdUserIds = [];
    createdEventIds = [];
  });

  async function seedUser(customerId: string) {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({ email: `webhook-test-${stamp}@run-far.local`, emailVerifiedAt: new Date(), stripeCustomerId: customerId })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdUserIds = [row.id];
    return row.id;
  }

  it("rejects a request with an invalid signature", async () => {
    const app = await buildServer();
    try {
      const { body } = signedPayload(subscriptionUpdatedEvent(`cus_${randomUUID()}`, `evt_${randomUUID()}`));
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": "t=0,v1=deadbeef" },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("applies a correctly signed subscription.updated event and updates entitlement", async () => {
    const customerId = `cus_${randomUUID()}`;
    const userId = await seedUser(customerId);
    const eventId = `evt_${randomUUID()}`;
    createdEventIds = [eventId];
    const app = await buildServer();
    try {
      const { body, signature } = signedPayload(subscriptionUpdatedEvent(customerId, eventId));
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        payload: body,
      });
      expect(res.statusCode).toBe(200);

      const [row] = await db.select().from(users).where(eq(users.id, userId));
      expect(row?.entitlementSource).toBe("stripe");
      expect(row?.entitlementStatus).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("dedupes a replayed event id instead of reprocessing it", async () => {
    const customerId = `cus_${randomUUID()}`;
    await seedUser(customerId);
    const eventId = `evt_${randomUUID()}`;
    createdEventIds = [eventId];
    const app = await buildServer();
    try {
      const { body, signature } = signedPayload(subscriptionUpdatedEvent(customerId, eventId));

      const first = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        payload: body,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        payload: body,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().deduped).toBe(true);

      const rows = await db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.id, eventId));
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  // Regression: the idempotency row used to be committed before the handler ran, so a handler
  // failure returned 500 (asking Stripe to retry) but the retry hit the dedupe and was acked —
  // dropping the event for good and leaving a paying athlete unentitled forever.
  it("lets Stripe retry an event whose handler failed", async () => {
    const eventId = `evt_${randomUUID()}`;
    createdEventIds = [eventId];
    // checkout.session.completed makes a live subscriptions.retrieve call, which throws
    // against the bogus test key — a stand-in for any transient failure inside handleEvent.
    const payload = {
      id: eventId,
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_test", object: "checkout.session", subscription: "sub_test" } },
    };
    const body = JSON.stringify(payload);
    const signature = stripeClient().webhooks.generateTestHeaderString({
      payload: body,
      secret: env.STRIPE_WEBHOOK_SECRET,
    });

    const app = await buildServer();
    try {
      const send = () =>
        app.inject({
          method: "POST",
          url: "/webhooks/stripe",
          headers: { "content-type": "application/json", "stripe-signature": signature },
          payload: body,
        });

      expect((await send()).statusCode).toBe(500);
      // The claim was released, so the retry is processed again rather than silently deduped.
      const retry = await send();
      expect(retry.statusCode).toBe(500);
      expect(retry.json().deduped).toBeUndefined();

      const rows = await db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.id, eventId));
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
