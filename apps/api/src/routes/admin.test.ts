import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * Regression coverage for the admin lockout: `role` is only ever granted by data migration
 * (drizzle/0018_handy_maddog.sql), so an admin account destroyed or locked out through the
 * backoffice can never be restored from inside the app. The pre-existing SELF_TARGET checks
 * only stopped an admin acting on their own row, which left every other admin destructible.
 */
describe("destructive admin actions against an admin account", () => {
  let actingAdminId: string;
  let otherAdminId: string;
  let plainUserId: string;
  let createdIds: string[];

  beforeEach(async () => {
    const stamp = randomUUID();
    const rows = await db
      .insert(users)
      .values([
        {
          email: `acting-admin-${stamp}@run-far.local`,
          role: "admin" as const,
          approvedAt: new Date(),
          emailVerifiedAt: new Date(),
        },
        {
          email: `other-admin-${stamp}@run-far.local`,
          role: "admin" as const,
          approvedAt: new Date(),
          emailVerifiedAt: new Date(),
        },
        {
          email: `plain-user-${stamp}@run-far.local`,
          approvedAt: new Date(),
          emailVerifiedAt: new Date(),
        },
      ])
      .returning({ id: users.id });
    [actingAdminId, otherAdminId, plainUserId] = rows.map((r) => r.id);
    createdIds = rows.map((r) => r.id);
  });

  afterEach(async () => {
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  const asActingAdmin = async (
    app: Awaited<ReturnType<typeof buildServer>>,
    method: "DELETE" | "POST",
    url: string,
  ) =>
    app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: app.signCookie(actingAdminId) },
    });

  it("refuses to delete another admin, and leaves the row intact", async () => {
    const app = await buildServer();
    try {
      const res = await asActingAdmin(app, "DELETE", `/api/admin/users/${otherAdminId}`);

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ADMIN_TARGET");

      const survivors = await db.select().from(users).where(inArray(users.id, [otherAdminId]));
      expect(survivors).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("refuses to disable another admin", async () => {
    const app = await buildServer();
    try {
      const res = await asActingAdmin(app, "POST", `/api/admin/users/${otherAdminId}/disable`);

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ADMIN_TARGET");

      const [row] = await db.select().from(users).where(inArray(users.id, [otherAdminId]));
      expect(row?.disabledAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("refuses to unapprove another admin", async () => {
    const app = await buildServer();
    try {
      const res = await asActingAdmin(app, "POST", `/api/admin/users/${otherAdminId}/unapprove`);

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ADMIN_TARGET");

      const [row] = await db.select().from(users).where(inArray(users.id, [otherAdminId]));
      expect(row?.approvedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("still deletes a non-admin account", async () => {
    const app = await buildServer();
    try {
      const res = await asActingAdmin(app, "DELETE", `/api/admin/users/${plainUserId}`);

      expect(res.statusCode).toBe(204);
      const survivors = await db.select().from(users).where(inArray(users.id, [plainUserId]));
      expect(survivors).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
