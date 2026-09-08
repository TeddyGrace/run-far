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
// Blank rather than `delete`: env.ts loads the repo-root .env with dotenv, which fills in any
// key that is *absent* from process.env — so deleting it here would just be undone on a dev
// machine that has a real RESEND_API_KEY (and the test would hit the live Resend API).
process.env.RESEND_API_KEY = "";

const { db } = await import("../db/client.js");
const { users, accessRequests, invitedEmails } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { eq } = await import("drizzle-orm");
const { issueAuthToken } = await import("../lib/authTokens.js");
const { authTokens } = await import("../db/schema.js");

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

  it("auto-comps a password signup when the email is already invited", async () => {
    const app = await buildServer();
    try {
      // Invited (allowlisted) up front — an admin invite should carry through to a password
      // signup as full access, not leave the account waiting for a second manual step.
      await db.insert(invitedEmails).values({ email: createdEmail });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: createdEmail, password: "a-fine-password-10" },
      });

      expect(res.statusCode).toBe(200);
      const [user] = await db.select().from(users).where(eq(users.email, createdEmail));
      expect(user?.entitlementSource).toBe("comp");
      expect(user?.entitlementStatus).toBe("active");
    } finally {
      await db.delete(invitedEmails).where(eq(invitedEmails.email, createdEmail));
      await app.close();
    }
  });

  it("does not auto-comp a password signup when the email was never invited", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: createdEmail, password: "a-fine-password-10" },
      });

      expect(res.statusCode).toBe(200);
      // Signup still succeeds — it's just not comped, so the account lands on the paywall
      // until it subscribes or an admin comps it (see lib/entitlement.ts).
      const [user] = await db.select().from(users).where(eq(users.email, createdEmail));
      expect(user).toBeDefined();
      expect(user?.entitlementSource).toBeNull();
      expect(user?.entitlementStatus).toBe("none");
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

describe("POST /api/auth/reset-password/check", () => {
  let email: string;
  let userId: string;

  beforeEach(async () => {
    email = `reset-check-${randomUUID()}@run-far.local`;
    const [user] = await db.insert(users).values({ email }).returning();
    userId = user!.id;
  });

  afterEach(async () => {
    await db.delete(authTokens).where(eq(authTokens.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("reports whose account a live link is for without spending the token", async () => {
    const app = await buildServer();
    try {
      const token = await issueAuthToken(userId, "password_reset");

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/reset-password/check",
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      // hasPassword false: a Google-only account, so the page can say the reset *adds* a password.
      expect(res.json()).toEqual({ valid: true, email, hasPassword: false });

      // The check must not consume the token — the actual reset still has to work.
      const reset = await app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        payload: { token, password: "a-fine-password-10" },
      });
      expect(reset.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("reports an already-used link as invalid", async () => {
    const app = await buildServer();
    try {
      const token = await issueAuthToken(userId, "password_reset");
      await app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        payload: { token, password: "a-fine-password-10" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/reset-password/check",
        payload: { token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: false });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/auth/login against a Google-only account", () => {
  let email: string;
  let userId: string;

  beforeEach(async () => {
    email = `google-only-${randomUUID()}@run-far.local`;
    const [user] = await db
      .insert(users)
      .values({ email, emailVerifiedAt: new Date(), googleSub: `sub-${randomUUID()}` })
      .returning();
    userId = user!.id;
  });

  afterEach(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  it("answers with the same generic 401 and notifies the owner at most once a day", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "not-the-right-password" },
      });

      // The response must not hint that this address exists or that it signs in with Google.
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: { message: "Invalid email or password", code: "INVALID_LOGIN" },
      });

      // The notice slot is claimed even though the mail transport is down in this suite —
      // a dead transport must not leave the throttle open for the next attempt.
      const [afterFirst] = await db.select().from(users).where(eq(users.id, userId));
      const firstNotice = afterFirst?.lastPasswordLoginNoticeAt;
      expect(firstNotice).toBeInstanceOf(Date);

      const second = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "not-the-right-password" },
      });
      expect(second.statusCode).toBe(401);

      const [afterSecond] = await db.select().from(users).where(eq(users.id, userId));
      expect(afterSecond?.lastPasswordLoginNoticeAt?.getTime()).toBe(firstNotice?.getTime());
    } finally {
      await app.close();
    }
  });

  it("notifies again once the throttle window has passed", async () => {
    const app = await buildServer();
    try {
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await db.update(users).set({ lastPasswordLoginNoticeAt: stale }).where(eq(users.id, userId));

      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "not-the-right-password" },
      });

      const [after] = await db.select().from(users).where(eq(users.id, userId));
      expect(after?.lastPasswordLoginNoticeAt?.getTime()).toBeGreaterThan(stale.getTime());
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/auth/reset-password", () => {
  let email: string;
  let userId: string;

  beforeEach(async () => {
    email = `reset-shape-${randomUUID()}@run-far.local`;
    const [user] = await db.insert(users).values({ email }).returning();
    userId = user!.id;
  });

  afterEach(async () => {
    await db.delete(authTokens).where(eq(authTokens.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("answers with the account's identity only — clients must refetch /auth/me", async () => {
    const app = await buildServer();
    try {
      const token = await issueAuthToken(userId, "password_reset");

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        payload: { token, password: "a-fine-password-10" },
      });

      expect(res.statusCode).toBe(200);
      // Pinned on purpose. The web client used to seed its ["auth","me"] cache with this
      // response, which rendered a session with no entitlement and blanked the page. Widening
      // this payload toward the /auth/me shape would make that mistake look survivable again.
      expect(res.json()).toEqual({ id: userId, email });
      expect(res.headers["set-cookie"]).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
