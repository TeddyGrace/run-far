import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
// Force the same "transport unusable" path production hits when RESEND_API_KEY is unset —
// see lib/mailer.ts. Outside production an unset key just logs the email instead of failing,
// which wouldn't exercise the degrade-instead-of-500 behavior this suite covers.
process.env.NODE_ENV = "production";
delete process.env.RESEND_API_KEY;

const { db } = await import("../db/client.js");
const { users, accessRequests } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { eq } = await import("drizzle-orm");

/**
 * Regression coverage for the outage where a password signup 500'd because the mail
 * transport (Resend — see lib/mailer.ts) was unconfigured: sendSystemMail should degrade
 * instead of throwing, so the account still gets created and shows up for an admin to handle
 * by hand instead of the signup silently failing.
 */
describe("POST /api/auth/signup with the mail transport down", () => {
  let createdEmail: string;

  beforeEach(() => {
    createdEmail = `mail-down-signup-${randomUUID()}@run-far.local`;
  });

  afterEach(async () => {
    await db.delete(accessRequests).where(eq(accessRequests.email, createdEmail));
    await db.delete(users).where(eq(users.email, createdEmail));
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
