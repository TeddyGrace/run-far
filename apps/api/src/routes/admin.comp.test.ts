import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users, aiUsage } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { inArray, eq } = await import("drizzle-orm");
const { resolveEntitlement } = await import("../lib/entitlement.js");

/**
 * Coverage for the backoffice comp switch (routes/admin.ts POST/DELETE .../comp) — the direct
 * "grant this account free access" action, independent of the invite/approve flow. Also covers
 * GET /api/admin/users surfacing entitlement + AI usage columns, since the two ship together.
 */
describe("backoffice comp endpoints", () => {
  let adminId: string;
  let createdIds: string[];

  afterEach(async () => {
    await db.delete(aiUsage).where(inArray(aiUsage.userId, createdIds));
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  async function seedAdmin() {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({
        email: `comp-admin-${stamp}@run-far.local`,
        role: "admin" as const,
        entitlementSource: "comp" as const,
        entitlementStatus: "active" as const,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed admin");
    return row.id;
  }

  async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}) {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({ email: `comp-user-${stamp}@run-far.local`, emailVerifiedAt: new Date(), ...overrides })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    return row.id;
  }

  it("comps a user, then un-comps them, round trip", async () => {
    adminId = await seedAdmin();
    const targetId = await seedUser();
    createdIds = [adminId, targetId];

    const app = await buildServer();
    try {
      const compRes = await app.inject({
        method: "POST",
        url: `/api/admin/users/${targetId}/comp`,
        cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
        payload: { note: "friends and family" },
      });
      expect(compRes.statusCode).toBe(200);
      expect(compRes.json()).toMatchObject({
        entitlementSource: "comp",
        entitlementStatus: "active",
        compNote: "friends and family",
      });

      const [row] = await db.select().from(users).where(eq(users.id, targetId));
      expect(row?.entitlementSource).toBe("comp");
      expect(row?.compedBy).toBe(adminId);

      const uncompRes = await app.inject({
        method: "DELETE",
        url: `/api/admin/users/${targetId}/comp`,
        cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
      });
      expect(uncompRes.statusCode).toBe(200);

      const [after] = await db.select().from(users).where(eq(users.id, targetId));
      expect(after?.entitlementSource).toBeNull();
      expect(after?.entitlementStatus).toBe("none");
    } finally {
      await app.close();
    }
  });

  // Regression: the comp endpoint used to leave entitlementExpiresAt alone, so comping
  // someone whose Stripe subscription had already lapsed returned a cheerful 200 while
  // resolveEntitlement still read the (stale, past) expiry and kept them behind the paywall.
  it("clears a stale expiry so a comp on a lapsed subscriber actually grants access", async () => {
    adminId = await seedAdmin();
    const targetId = await seedUser({
      entitlementSource: "stripe",
      entitlementStatus: "canceled",
      entitlementExpiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    createdIds = [adminId, targetId];

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${targetId}/comp`,
        cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
        payload: { note: "make it right" },
      });
      expect(res.statusCode).toBe(200);

      const [row] = await db.select().from(users).where(eq(users.id, targetId));
      expect(row?.entitlementExpiresAt).toBeNull();
      expect(resolveEntitlement(row!).active).toBe(true);

      // The end that actually matters: a gated route lets them back in.
      const gated = await app.inject({
        method: "GET",
        url: "/api/runs",
        cookies: { [SESSION_COOKIE]: app.signCookie(targetId) },
      });
      expect(gated.statusCode).not.toBe(402);
    } finally {
      await app.close();
    }
  });

  it("refuses to un-comp a user whose entitlement isn't currently a comp", async () => {
    adminId = await seedAdmin();
    const targetId = await seedUser({ entitlementSource: "stripe", entitlementStatus: "active" });
    createdIds = [adminId, targetId];

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/admin/users/${targetId}/comp`,
        cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
      });
      expect(res.statusCode).toBe(404);

      const [row] = await db.select().from(users).where(eq(users.id, targetId));
      expect(row?.entitlementSource).toBe("stripe");
    } finally {
      await app.close();
    }
  });

  it("refuses to comp an admin account", async () => {
    adminId = await seedAdmin();
    const otherAdminId = await seedAdmin();
    createdIds = [adminId, otherAdminId];

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${otherAdminId}/comp`,
        cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("surfaces entitlement and this-month AI usage on the users list", async () => {
    adminId = await seedAdmin();
    const targetId = await seedUser({ entitlementSource: "comp", entitlementStatus: "active" });
    createdIds = [adminId, targetId];
    await db.insert(aiUsage).values({
      userId: targetId,
      surface: "assistant",
      model: "claude-sonnet-4-5",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostMicros: 12_345,
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
      });
      expect(res.statusCode).toBe(200);
      const row = res.json().find((u: { id: string }) => u.id === targetId);
      expect(row).toMatchObject({ entitlementSource: "comp", aiUsageThisMonthMicros: 12_345 });
    } finally {
      await app.close();
    }
  });
});
