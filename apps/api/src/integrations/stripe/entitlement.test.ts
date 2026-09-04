import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../../db/client.js");
const { users } = await import("../../db/schema.js");
const { inArray, eq } = await import("drizzle-orm");
const { applyStripeSubscription } = await import("./entitlement.js");

function fakeSubscription(overrides: Partial<Stripe.Subscription> & { customerId: string; userId?: string }): Stripe.Subscription {
  const { customerId, userId, ...rest } = overrides;
  return {
    id: `sub_${randomUUID()}`,
    object: "subscription",
    customer: customerId,
    status: "active",
    metadata: userId ? { userId } : {},
    items: {
      object: "list",
      data: [
        {
          id: `si_${randomUUID()}`,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          current_period_start: Math.floor(Date.now() / 1000),
        } as Stripe.SubscriptionItem,
      ],
      has_more: false,
      url: "",
    },
    ...rest,
  } as Stripe.Subscription;
}

describe("applyStripeSubscription", () => {
  let createdIds: string[];

  afterEach(async () => {
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  async function seedUser(overrides: Partial<typeof users.$inferInsert>) {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({ email: `stripe-ent-test-${stamp}@run-far.local`, emailVerifiedAt: new Date(), ...overrides })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
    return row.id;
  }

  it("applies an active subscription to a user found by stripeCustomerId", async () => {
    const customerId = `cus_${randomUUID()}`;
    const userId = await seedUser({ stripeCustomerId: customerId });

    await applyStripeSubscription(fakeSubscription({ customerId, status: "active" }), new Date());

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.entitlementSource).toBe("stripe");
    expect(row?.entitlementStatus).toBe("active");
    expect(row?.entitlementExpiresAt).not.toBeNull();
  });

  it("falls back to the userId in subscription metadata when stripeCustomerId doesn't match", async () => {
    const userId = await seedUser({});
    const customerId = `cus_${randomUUID()}`; // not stored on the user row

    await applyStripeSubscription(fakeSubscription({ customerId, userId, status: "trialing" }), new Date());

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.entitlementSource).toBe("stripe");
    expect(row?.entitlementStatus).toBe("trialing");
    expect(row?.stripeCustomerId).toBe(customerId);
  });

  it("never overwrites a comped user's entitlementSource, but still records the subscription ids", async () => {
    const customerId = `cus_${randomUUID()}`;
    const userId = await seedUser({
      stripeCustomerId: customerId,
      entitlementSource: "comp",
      entitlementStatus: "active",
      compedAt: new Date(),
    });

    await applyStripeSubscription(fakeSubscription({ customerId, status: "canceled" }), new Date());

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.entitlementSource).toBe("comp");
    expect(row?.entitlementStatus).toBe("active");
    expect(row?.stripeSubscriptionId).not.toBeNull();
  });

  it("ignores an event older than the last one already applied", async () => {
    const customerId = `cus_${randomUUID()}`;
    const syncedAt = new Date("2026-06-01T00:00:00Z");
    const userId = await seedUser({
      stripeCustomerId: customerId,
      entitlementSource: "stripe",
      entitlementStatus: "active",
      entitlementSyncedAt: syncedAt,
    });

    const staleEvent = new Date("2026-05-01T00:00:00Z");
    await applyStripeSubscription(fakeSubscription({ customerId, status: "canceled" }), staleEvent);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    // Status should be unchanged — the stale event was dropped.
    expect(row?.entitlementStatus).toBe("active");
  });

  it("maps an unrecognized Stripe status to canceled rather than granting access", async () => {
    const customerId = `cus_${randomUUID()}`;
    const userId = await seedUser({ stripeCustomerId: customerId });

    await applyStripeSubscription(fakeSubscription({ customerId, status: "incomplete_expired" }), new Date());

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.entitlementStatus).toBe("canceled");
  });
});
