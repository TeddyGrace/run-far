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

  it("emails an invitation when approving an access request with no account", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("request-no-account");
      const [reqRow] = await db
        .insert(accessRequests)
        .values({ email })
        .returning({ id: accessRequests.id });
      if (!reqRow) throw new Error("failed to seed access request");

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/access-requests/${reqRow.id}/approve`,
        cookies: adminCookie(app),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("invited");
      expect(subjects()).toEqual(["You're invited to run-far"]);
    } finally {
      await app.close();
    }
  });

  it("approves the account and sends the approved mail when the access request has a pending account", async () => {
    const app = await buildServer();
    try {
      const email = seedEmail("request-with-account");
      await db.insert(users).values({ email, passwordHash: "x", approvedAt: null });
      const [reqRow] = await db
        .insert(accessRequests)
        .values({ email })
        .returning({ id: accessRequests.id });
      if (!reqRow) throw new Error("failed to seed access request");

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/access-requests/${reqRow.id}/approve`,
        cookies: adminCookie(app),
      });

      expect(res.statusCode).toBe(200);
      const [user] = await db.select().from(users).where(eq(users.email, email));
      expect(user?.approvedAt).not.toBeNull();
      expect(subjects()).toEqual(["You're in — run-far access approved"]);
    } finally {
      await app.close();
    }
  });
});
