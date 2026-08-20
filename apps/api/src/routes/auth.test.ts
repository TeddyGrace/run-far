import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users, accessRequests } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { eq } = await import("drizzle-orm");

/**
 * Regression coverage for the outage where a password signup 500'd because the admin's
 * Gmail grant (the only mail transport — see systemMail.ts) was dead: sendSystemMail should
 * degrade instead of throwing, so the account still gets created and shows up for an admin
 * to handle by hand instead of the signup silently failing.
 *
 * No Google connection is set up for the admin here, which is enough to reach the same
 * MailTransportDownError path invalid_grant does (both are "the transport is unusable").
 */
describe("POST /api/auth/signup with the mail transport down", () => {
  let adminId: string;
  let createdEmail: string;

  beforeEach(async () => {
    const [admin] = await db
      .insert(users)
      .values({
        email: `mail-down-admin-${randomUUID()}@run-far.local`,
        passwordHash: "x",
        role: "admin",
      })
      .returning({ id: users.id });
    adminId = admin!.id;
    createdEmail = `mail-down-signup-${randomUUID()}@run-far.local`;
  });

  afterEach(async () => {
    await db.delete(accessRequests).where(eq(accessRequests.email, createdEmail));
    await db.delete(users).where(eq(users.email, createdEmail));
    await db.delete(users).where(eq(users.id, adminId));
  });

  it("still creates the account and returns 200 instead of 500ing", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: createdEmail, password: "a-fine-password-10" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, mailSent: false });

      const [user] = await db.select().from(users).where(eq(users.email, createdEmail));
      expect(user).toBeDefined();
      expect(user?.emailVerifiedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("records an access request so the signup is visible in the backoffice without the email", async () => {
    const app = await buildServer();
    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: createdEmail, password: "a-fine-password-10" },
      });

      const [request] = await db.select().from(accessRequests).where(eq(accessRequests.email, createdEmail));
      expect(request).toBeDefined();
      expect(request?.status).toBe("pending");
    } finally {
      await app.close();
    }
  });

  it("returns the same generic response when the email already has an account", async () => {
    const app = await buildServer();
    try {
      await db.insert(users).values({ email: createdEmail, passwordHash: "x" });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: createdEmail, password: "a-fine-password-10" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
