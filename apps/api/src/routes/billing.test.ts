import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.STRIPE_SECRET_KEY ??= "sk_test_not_a_real_key";
process.env.STRIPE_PRICE_MONTHLY ??= "price_test_monthly";
process.env.STRIPE_PRICE_ANNUAL ??= "price_test_annual";

const { db } = await import("../db/client.js");
const { users } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { inArray } = await import("drizzle-orm");

describe("POST /api/billing/checkout", () => {
  let createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length) await db.delete(users).where(inArray(users.id, createdIds));
    createdIds = [];
  });

  async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}) {
    const [row] = await db
      .insert(users)
      .values({ email: `billing-${randomUUID()}@run-far.local`, emailVerifiedAt: new Date(), ...overrides })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
    return row.id;
  }

  // Stripe would happily open a second subscription on the same customer — two charges, and
  // two streams of webhooks racing over one entitlement row.
  it("refuses a second checkout for an already-subscribed athlete", async () => {
    const userId = await seedUser({
      entitlementSource: "stripe",
      entitlementStatus: "active",
      entitlementExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: `sub_${randomUUID()}`,
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/billing/checkout",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { plan: "monthly" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ALREADY_SUBSCRIBED");
    } finally {
      await app.close();
    }
  });

  // A comp is an admin grant, not a subscription — it must not block someone who wants to
  // start paying (nor does it conflict with one; see lib/entitlement.ts, where comp wins).
  it("lets a comped athlete start a checkout anyway", async () => {
    const userId = await seedUser({ entitlementSource: "comp", entitlementStatus: "active" });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/billing/checkout",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { plan: "monthly" },
      });
      // Gets past the guard and out to Stripe, which rejects the fake test key — the point is
      // that it is NOT a 409.
      expect(res.statusCode).not.toBe(409);
    } finally {
      await app.close();
    }
  });

  // A lapsed subscriber is exactly who should be able to check out again.
  it("lets a lapsed subscriber start a new checkout", async () => {
    const userId = await seedUser({
      entitlementSource: "stripe",
      entitlementStatus: "canceled",
      entitlementExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      stripeCustomerId: `cus_${randomUUID()}`,
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/billing/checkout",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { plan: "monthly" },
      });
      expect(res.statusCode).not.toBe(409);
    } finally {
      await app.close();
    }
  });
});
