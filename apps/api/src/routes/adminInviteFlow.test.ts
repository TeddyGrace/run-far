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
const { users, invitedEmails, accessRequests } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { eq } = await import("drizzle-orm");

/**
 * The backoffice invite/approval flow: inviting emails the invitee and auto-approves any waiting
 * account, approvals are idempotent (no duplicate "you're approved" mail), and approving an
 * access request always notifies someone. See routes/admin.ts approveExistingUser.
 */
describe("backoffice invite & approval flow", () => {
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
        approvedAt: new Date(),
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
      await db.delete(accessRequests).where(eq(accessRequests.email, email));
    }
  });

  const adminCookie = (app: Awaited<ReturnType<typeof buildServer>>) => ({
    [SESSION_COOKIE]: app.signCookie(adminId),
  });

  const subjects = () => sendMail.mock.calls.map(([m]) => m.subject);

  it("emails an invitation and allowlists the email when no account exists yet", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("fresh-invite");
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/invites",
        cookies: adminCookie(app),
        payload: { email },
      });

      expect(res.statusCode).toBe(201);
      const [invite] = await db.select().from(invitedEmails).where(eq(invitedEmails.email, email));
      expect(invite).toBeDefined();
      expect(subjects()).toEqual(["You're invited to run-far"]);
    } finally {
      await app.close();
    }
  });

  it("auto-approves an already-pending account when invited, sending the approved mail once", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("pending-then-invited");
      await db.insert(users).values({ email, passwordHash: "x", approvedAt: null });

      const res = await app.inject({
        method: "POST",
        url: "/api/admin/invites",
        cookies: adminCookie(app),
        payload: { email },
      });

      expect(res.statusCode).toBe(201);
      const [user] = await db.select().from(users).where(eq(users.email, email));
      expect(user?.approvedAt).not.toBeNull();
      // Exactly one mail, and it's the approval — not the generic invitation.
      expect(subjects()).toEqual(["You're in — run-far access approved"]);
    } finally {
      await app.close();
    }
  });

  it("makes users/:id/approve idempotent — a second approve sends no second email", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("double-approve");
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash: "x", approvedAt: null })
        .returning({ id: users.id });
      if (!user) throw new Error("failed to seed user");

      const first = await app.inject({
        method: "POST",
        url: `/api/admin/users/${user.id}/approve`,
        cookies: adminCookie(app),
      });
      expect(first.statusCode).toBe(200);
      const [afterFirst] = await db.select().from(users).where(eq(users.email, email));
      const firstApprovedAt = afterFirst?.approvedAt;
      expect(firstApprovedAt).not.toBeNull();

      const second = await app.inject({
        method: "POST",
        url: `/api/admin/users/${user.id}/approve`,
        cookies: adminCookie(app),
      });
      expect(second.statusCode).toBe(200);

      // No second mail, and the original approval timestamp is untouched (no churn).
      expect(sendMail).toHaveBeenCalledTimes(1);
      const [afterSecond] = await db.select().from(users).where(eq(users.email, email));
      expect(afterSecond?.approvedAt?.getTime()).toBe(firstApprovedAt?.getTime());
    } finally {
      await app.close();
    }
  });

  it("emails an invitation when inviting an email with an access-request log but no account", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("request-no-account");
      await db.insert(accessRequests).values({ email });

      const res = await app.inject({
        method: "POST",
        url: "/api/admin/invites",
        cookies: adminCookie(app),
        payload: { email },
      });

      expect(res.statusCode).toBe(201);
      const [reqRow] = await db.select().from(accessRequests).where(eq(accessRequests.email, email));
      expect(reqRow?.status).toBe("invited");
      expect(subjects()).toEqual(["You're invited to run-far"]);
    } finally {
      await app.close();
    }
  });

  it("approves the account and sends the approved mail when approving a user with an access-request log", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("request-with-account");
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash: "x", approvedAt: null })
        .returning({ id: users.id });
      if (!user) throw new Error("failed to seed user");
      await db.insert(accessRequests).values({ email });

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${user.id}/approve`,
        cookies: adminCookie(app),
      });

      expect(res.statusCode).toBe(200);
      const [updatedUser] = await db.select().from(users).where(eq(users.email, email));
      expect(updatedUser?.approvedAt).not.toBeNull();
      const [reqRow] = await db.select().from(accessRequests).where(eq(accessRequests.email, email));
      expect(reqRow?.status).toBe("invited");
      expect(subjects()).toEqual(["You're in — run-far access approved"]);
    } finally {
      await app.close();
    }
  });

  it("denying a pending signup disables the account, dismisses its access request, and clears its invite", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("denied-signup");
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash: "x", approvedAt: null })
        .returning({ id: users.id });
      if (!user) throw new Error("failed to seed user");
      await db.insert(accessRequests).values({ email });
      await db.insert(invitedEmails).values({ email, invitedBy: adminId });

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${user.id}/deny`,
        cookies: adminCookie(app),
      });

      expect(res.statusCode).toBe(200);
      const [updatedUser] = await db.select().from(users).where(eq(users.email, email));
      expect(updatedUser?.disabledAt).not.toBeNull();
      expect(updatedUser?.approvedAt).toBeNull();
      const [reqRow] = await db.select().from(accessRequests).where(eq(accessRequests.email, email));
      expect(reqRow?.status).toBe("dismissed");
      const [invite] = await db.select().from(invitedEmails).where(eq(invitedEmails.email, email));
      expect(invite).toBeUndefined();
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
