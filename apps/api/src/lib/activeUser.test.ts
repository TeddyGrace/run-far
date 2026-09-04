import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { inArray } = await import("drizzle-orm");

/**
 * Coverage for the entitlement gate in activeUserGuard: an unentitled user is blocked from
 * ordinary /api routes with 402 PAYMENT_REQUIRED, but can still reach the small allowlist
 * needed to check status, subscribe, or close their account. Comped/admin users pass through
 * unaffected — see lib/entitlement.ts for the resolution order this exercises indirectly.
 */
describe("activeUserGuard entitlement gate", () => {
  let createdIds: string[];

  afterEach(async () => {
    if (createdIds.length) await db.delete(users).where(inArray(users.id, createdIds));
  });

  async function seedUser(overrides: Partial<typeof users.$inferInsert>) {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({
        email: `guard-test-${stamp}@run-far.local`,
        emailVerifiedAt: new Date(),
        ...overrides,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
    return row.id;
  }

  it("blocks an unentitled user from an ordinary /api route with 402", async () => {
    const userId = await seedUser({ entitlementSource: null, entitlementStatus: "none" });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(402);
      expect(res.json().error.code).toBe("PAYMENT_REQUIRED");
    } finally {
      await app.close();
    }
  });

  it("lets an unentitled user still reach /api/auth/me", async () => {
    const userId = await seedUser({ entitlementSource: null, entitlementStatus: "none" });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entitlement.active).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("lets an unentitled user reach any /api/billing/* route", async () => {
    const userId = await seedUser({ entitlementSource: null, entitlementStatus: "none" });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/billing/status",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      // No billing routes exist yet in this phase — 404, not 402, proves the guard let it
      // through before routing ever got a chance to reject it.
      expect(res.statusCode).not.toBe(402);
    } finally {
      await app.close();
    }
  });

  it("allows a comped user through to an ordinary /api route", async () => {
    const userId = await seedUser({ entitlementSource: "comp", entitlementStatus: "active" });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).not.toBe(402);
    } finally {
      await app.close();
    }
  });

  it("allows an admin through regardless of entitlement columns", async () => {
    const userId = await seedUser({
      role: "admin",
      entitlementSource: null,
      entitlementStatus: "none",
    });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).not.toBe(402);
    } finally {
      await app.close();
    }
  });

  it("blocks a disabled user with 401 even if they're comped", async () => {
    const userId = await seedUser({
      entitlementSource: "comp",
      entitlementStatus: "active",
      disabledAt: new Date(),
    });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("ACCOUNT_DISABLED");
    } finally {
      await app.close();
    }
  });
});
