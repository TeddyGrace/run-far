import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

// Count every outbound email without hitting Resend. Mocking the transport (not sendSystemMail)
// keeps the route's own send/catch logic under test while letting us assert how many mails, and
// which subjects, each admin action produces.
const sendMail = vi.fn(async (_params: { to: string; subject: string; html: string; text: string }) => {});
vi.mock("../lib/mailer.js", () => ({
  sendMail,
  MailTransportDownError: class MailTransportDownError extends Error {},
}));

const { db } = await import("../db/client.js");
const { users, invitedEmails } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { eq } = await import("drizzle-orm");

/**
 * The backoffice free-access invite flow. Signup itself is open to everyone (see shouldAutoComp
 * in routes/auth.ts) — an invite only decides who skips the paywall, so inviting an email that
 * already has an account grants that account free access on the spot. See grantInviteComp in
 * routes/admin.ts.
 */
describe("backoffice free-access invites", () => {
  let adminId: string;
  let stamp: string;
  let emails: string[];

  const seedEmail = (label: string) => {
    const email = `${label}-${stamp}@run-far.local`;
    emails.push(email);
    return email;
  };

  beforeEach(async () => {
    stamp = randomUUID();
    emails = [];
    sendMail.mockClear();
    const [admin] = await db
      .insert(users)
      .values({
        email: seedEmail("invite-admin"),
        role: "admin" as const,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!admin) throw new Error("failed to seed admin");
    adminId = admin.id;
  });

  afterEach(async () => {
    for (const email of emails) {
      await db.delete(users).where(eq(users.email, email));
      await db.delete(invitedEmails).where(eq(invitedEmails.email, email));
    }
  });

  const adminCookie = (app: Awaited<ReturnType<typeof buildServer>>) => ({
    [SESSION_COOKIE]: app.signCookie(adminId),
  });

  const subjects = () => sendMail.mock.calls.map(([m]) => m.subject);

  const invite = async (app: Awaited<ReturnType<typeof buildServer>>, email: string) =>
    app.inject({ method: "POST", url: "/api/admin/invites", cookies: adminCookie(app), payload: { email } });

  it("emails an invitation and allowlists the email when no account exists yet", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("fresh-invite");
      const res = await invite(app, email);

      expect(res.statusCode).toBe(201);
      const [row] = await db.select().from(invitedEmails).where(eq(invitedEmails.email, email));
      expect(row).toBeDefined();
      expect(subjects()).toEqual(["You're invited to run-far"]);
    } finally {
      await app.close();
    }
  });

  it("grants free access to an account that already exists, sending the access mail once", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("existing-then-invited");
      await db.insert(users).values({ email, passwordHash: "x" });

      const res = await invite(app, email);

      expect(res.statusCode).toBe(201);
      const [user] = await db.select().from(users).where(eq(users.email, email));
      expect(user?.entitlementSource).toBe("comp");
      expect(user?.entitlementStatus).toBe("active");
      expect(user?.compedAt).not.toBeNull();
      // Exactly one mail, and it's the access grant — not the generic invitation.
      expect(subjects()).toEqual(["You're in — run-far access approved"]);
    } finally {
      await app.close();
    }
  });

  // compedAt is the idempotency key: a second invite must not re-stamp the grant, and must not
  // mail a signup link to someone who is already using the account.
  it("is idempotent — a second invite of the same email sends no second email", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("double-invite");
      await db.insert(users).values({ email, passwordHash: "x" });

      expect((await invite(app, email)).statusCode).toBe(201);
      const [afterFirst] = await db.select().from(users).where(eq(users.email, email));
      const firstCompedAt = afterFirst?.compedAt;
      expect(firstCompedAt).not.toBeNull();

      expect((await invite(app, email)).statusCode).toBe(201);

      expect(sendMail).toHaveBeenCalledTimes(1);
      const [afterSecond] = await db.select().from(users).where(eq(users.email, email));
      expect(afterSecond?.compedAt?.getTime()).toBe(firstCompedAt?.getTime());
    } finally {
      await app.close();
    }
  });

  // The whole point of the grant: a stale expiry from a lapsed subscription must not survive it,
  // or resolveEntitlement reads the new comp as already expired. Mirrors the same guard on
  // POST /users/:id/comp (admin.comp.test.ts).
  it("clears a stale expiry when granting free access to a lapsed subscriber", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("lapsed-then-invited");
      await db.insert(users).values({
        email,
        passwordHash: "x",
        entitlementSource: "stripe",
        entitlementStatus: "canceled",
        entitlementExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      expect((await invite(app, email)).statusCode).toBe(201);

      const [user] = await db.select().from(users).where(eq(users.email, email));
      expect(user?.entitlementSource).toBe("comp");
      expect(user?.entitlementExpiresAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  // Re-granting after a revoke is a real action, not a no-op: DELETE /comp nulls compedAt, so
  // the idempotency guard above must let the next invite through (and mail again).
  it("re-grants free access after it was revoked", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("revoked-then-reinvited");
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash: "x" })
        .returning({ id: users.id });
      if (!user) throw new Error("failed to seed user");

      expect((await invite(app, email)).statusCode).toBe(201);
      const revoke = await app.inject({
        method: "DELETE",
        url: `/api/admin/users/${user.id}/comp`,
        cookies: adminCookie(app),
      });
      expect(revoke.statusCode).toBe(200);

      expect((await invite(app, email)).statusCode).toBe(201);

      const [after] = await db.select().from(users).where(eq(users.email, email));
      expect(after?.entitlementSource).toBe("comp");
      expect(sendMail).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
