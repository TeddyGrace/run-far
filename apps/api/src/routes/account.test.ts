import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

// Account deletion best-effort revokes OAuth grants at the provider — stub the network so
// tests never make a real call to Google/Whoop, and stay hermetic and fast.
vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

const { db } = await import("../db/client.js");
const { users, oauthConnections, trainingPlans } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { encryptSecret } = await import("../lib/crypto.js");
const { hashPassword } = await import("../lib/auth.js");
const { inArray, eq } = await import("drizzle-orm");

describe("account self-service", () => {
  let createdIds: string[];

  afterEach(async () => {
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}) {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({
        email: `account-test-${stamp}@run-far.local`,
        emailVerifiedAt: new Date(),
        entitlementSource: null,
        entitlementStatus: "none",
        ...overrides,
      })
      .returning({ id: users.id, email: users.email });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
    return row;
  }

  it("lets an unentitled user reach export and delete despite the 402 gate", async () => {
    const { id: userId } = await seedUser();
    const app = await buildServer();
    try {
      const exportRes = await app.inject({
        method: "GET",
        url: "/api/account/export",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(exportRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("exports the user's own plans and runs, not oauth connection secrets", async () => {
    const { id: userId } = await seedUser();
    await db.insert(trainingPlans).values({ userId, name: "Test plan", status: "active" });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/account/export",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trainingPlans).toHaveLength(1);
      expect(body).not.toHaveProperty("oauthConnections");
    } finally {
      await db.delete(trainingPlans).where(eq(trainingPlans.userId, userId));
      await app.close();
    }
  });

  it("deletes the account, cascades owned data, and revokes oauth grants", async () => {
    const { id: userId, email } = await seedUser();
    await db.insert(oauthConnections).values({
      userId,
      provider: "whoop",
      accessTokenEnc: encryptSecret("fake-access-token"),
      refreshTokenEnc: encryptSecret("fake-refresh-token"),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/account",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { confirmEmail: email },
      });
      expect(res.statusCode).toBe(200);

      const survivors = await db.select().from(users).where(inArray(users.id, [userId]));
      expect(survivors).toHaveLength(0);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("api.prod.whoop.com/oauth/oauth2/revoke"),
        expect.anything(),
      );

      createdIds = []; // already gone — afterEach has nothing to clean up
    } finally {
      await app.close();
    }
  });

  it("refuses to delete an admin account", async () => {
    const { id: userId } = await seedUser({ role: "admin" });
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/account",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ADMIN_TARGET");

      const survivors = await db.select().from(users).where(inArray(users.id, [userId]));
      expect(survivors).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  it("refuses to delete without the re-auth confirmation", async () => {
    const { id: userId } = await seedUser();
    const app = await buildServer();
    try {
      // A passwordless (Google) account confirms by typing its own email — a live session
      // cookie alone must not be enough to cascade-delete everything.
      const bare = await app.inject({
        method: "DELETE",
        url: "/api/account",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(bare.statusCode).toBe(400);
      expect(bare.json().error.code).toBe("CONFIRM_EMAIL_MISMATCH");

      const wrong = await app.inject({
        method: "DELETE",
        url: "/api/account",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { confirmEmail: "someone-else@run-far.local" },
      });
      expect(wrong.statusCode).toBe(400);

      expect(await db.select().from(users).where(inArray(users.id, [userId]))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("requires the account password when the account has one", async () => {
    const { id: userId, email } = await seedUser({ passwordHash: await hashPassword("correct horse") });
    const app = await buildServer();
    try {
      // The email confirmation is only for accounts with no password to re-enter.
      const viaEmail = await app.inject({
        method: "DELETE",
        url: "/api/account",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { confirmEmail: email },
      });
      expect(viaEmail.statusCode).toBe(401);
      expect(viaEmail.json().error.code).toBe("INVALID_PASSWORD");

      const ok = await app.inject({
        method: "DELETE",
        url: "/api/account",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { password: "correct horse" },
      });
      expect(ok.statusCode).toBe(200);
      expect(await db.select().from(users).where(inArray(users.id, [userId]))).toHaveLength(0);
      createdIds = [];
    } finally {
      await app.close();
    }
  });
});
