import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

const { db } = await import("../db/client.js");
const { users, healthIngestDevices, recoveryMetrics } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { and, eq, inArray } = await import("drizzle-orm");

/**
 * The Apple Health endpoints introduce the app's only long-lived, non-cookie credential: a
 * device token, held in the iOS Keychain, used when HealthKit background delivery wakes native
 * code with no WebView and therefore no cookies.
 *
 * A credential with no expiry has to be gated as carefully as the session it stands in for,
 * which is what these cover: a revoked device stops working, and a disabled or unentitled
 * account's device stops working too — the case that would otherwise quietly keep syncing
 * forever, since a device token never ages out on its own.
 */
describe("apple health device auth", () => {
  let userIds: string[] = [];

  afterEach(async () => {
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    userIds = [];
  });

  async function seedUser(
    overrides: Partial<{
      entitlementSource: "comp" | "stripe" | "apple" | null;
      entitlementStatus: "none" | "active" | "trialing" | "past_due" | "canceled";
      disabledAt: Date | null;
    }> = {},
  ) {
    const [row] = await db
      .insert(users)
      .values({
        email: `apple-route-${randomUUID()}@run-far.local`,
        emailVerifiedAt: new Date(),
        entitlementSource: "comp",
        entitlementStatus: "active",
        timezone: "America/New_York",
        activeHealthProvider: "apple_health",
        ...overrides,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed user");
    userIds.push(row.id);
    return row.id;
  }

  const PAYLOAD = {
    device: { model: "iPhone 15 Pro" },
    coveredThrough: "2026-09-12T18:00:00.000Z",
    sleepSessions: [
      {
        externalId: "sleep-a",
        startedAt: "2026-09-12T03:00:00.000Z",
        endedAt: "2026-09-12T11:00:00.000Z",
        asleepMin: 460,
        hrvSdnnMs: 61,
        restingHr: 49,
      },
    ],
    workouts: [],
  };

  it("issues a device token to a signed-in athlete and accepts pushes with it", async () => {
    const userId = await seedUser();
    const app = await buildServer();
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/apple-health/devices",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { label: "iPhone 15 Pro" },
      });
      expect(registered.statusCode).toBe(200);
      const { token } = registered.json();
      expect(typeof token).toBe("string");

      // Only the hash is persisted — a database copy must not be usable as the credential.
      const [stored] = await db
        .select({ tokenHash: healthIngestDevices.tokenHash })
        .from(healthIngestDevices)
        .where(eq(healthIngestDevices.userId, userId));
      expect(stored?.tokenHash).not.toBe(token);

      const pushed = await app.inject({
        method: "POST",
        url: "/api/apple-health/ingest",
        headers: { authorization: `Bearer ${token}` },
        payload: PAYLOAD,
      });
      expect(pushed.statusCode).toBe(200);
      expect(pushed.json()).toMatchObject({ sleepSessions: 1, storedButNotActive: false });

      const rows = await db
        .select({ id: recoveryMetrics.id })
        .from(recoveryMetrics)
        .where(
          and(eq(recoveryMetrics.userId, userId), eq(recoveryMetrics.provider, "apple_health")),
        );
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a push with no credential at all", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/apple-health/ingest",
        payload: PAYLOAD,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects a revoked device", async () => {
    const userId = await seedUser();
    const app = await buildServer();
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/apple-health/devices",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { label: "Old phone" },
      });
      const { id, token } = registered.json();

      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/apple-health/devices/${id}`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(revoked.statusCode).toBe(200);

      const res = await app.inject({
        method: "POST",
        url: "/api/apple-health/ingest",
        headers: { authorization: `Bearer ${token}` },
        payload: PAYLOAD,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("stops accepting pushes once the account is disabled", async () => {
    // The case a cookie-only guard would miss: a device token has no expiry, so without the
    // guard understanding it, a disabled account's phone would keep syncing indefinitely.
    const userId = await seedUser();
    const app = await buildServer();
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/apple-health/devices",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: {},
      });
      const { token } = registered.json();

      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));

      const res = await app.inject({
        method: "POST",
        url: "/api/apple-health/ingest",
        headers: { authorization: `Bearer ${token}` },
        payload: PAYLOAD,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("stops accepting pushes once the entitlement lapses", async () => {
    const userId = await seedUser();
    const app = await buildServer();
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/apple-health/devices",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: {},
      });
      const { token } = registered.json();

      await db
        .update(users)
        .set({ entitlementSource: "stripe", entitlementStatus: "canceled" })
        .where(eq(users.id, userId));

      const res = await app.inject({
        method: "POST",
        url: "/api/apple-health/ingest",
        headers: { authorization: `Bearer ${token}` },
        payload: PAYLOAD,
      });
      expect(res.statusCode).toBe(402);
    } finally {
      await app.close();
    }
  });

  it("accepts data for an athlete still on Whoop, and says it isn't being read yet", async () => {
    // Storing it is right — they should arrive at Apple Health with history already there — but
    // the app has to be able to tell the athlete why their dashboard hasn't changed.
    const userId = await seedUser();
    await db.update(users).set({ activeHealthProvider: "whoop" }).where(eq(users.id, userId));
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/apple-health/ingest",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: PAYLOAD,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ activeProvider: "whoop", storedButNotActive: true });
    } finally {
      await app.close();
    }
  });

  it("won't let one athlete revoke another's device", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const app = await buildServer();
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/apple-health/devices",
        cookies: { [SESSION_COOKIE]: app.signCookie(owner) },
        payload: {},
      });
      const { id } = registered.json();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/apple-health/devices/${id}`,
        cookies: { [SESSION_COOKIE]: app.signCookie(stranger) },
      });
      expect(res.statusCode).toBe(404);

      const [still] = await db
        .select({ revokedAt: healthIngestDevices.revokedAt })
        .from(healthIngestDevices)
        .where(eq(healthIngestDevices.id, id));
      expect(still?.revokedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
