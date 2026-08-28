import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { invitedEmails, accessRequests, users } from "../db/schema.js";
import { requireAdminUserId } from "../lib/adminAuth.js";
import { sendSystemMail } from "../lib/systemMail.js";
import { accessApprovedEmail, inviteEmail } from "../lib/emailTemplates.js";
import { logger } from "../lib/logger.js";

const addInviteSchema = z.object({
  email: z.string().email(),
  note: z.string().trim().max(500).optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Loads the target of a destructive account action, refusing it outright when that account is
 * an admin. `role` is granted only by data migration (drizzle/0018_handy_maddog.sql) and by no
 * app route, so an admin that gets deleted — or locked out via disable/unapprove — can't be
 * replaced from inside the app, permanently orphaning the backoffice. The SELF_TARGET checks
 * don't cover this: they only stop an admin acting on their own row, not on another admin's.
 * Sends 404/403 and returns undefined on failure — callers should `if (!target) return;`.
 */
async function loadDestructibleUser(id: string, reply: FastifyReply) {
  const [target] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, id));
  if (!target) {
    reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
    return undefined;
  }
  if (target.role === "admin") {
    reply.status(403).send({
      error: {
        message: "Admin accounts can't be deleted, disabled, or unapproved",
        code: "ADMIN_TARGET",
      },
    });
    return undefined;
  }
  return target;
}

/**
 * Approves whatever account exists for `email`, idempotently, and keeps the invite/access-request
 * surfaces in sync. Every approval path (invite creation, the users list, the access-requests
 * list) funnels through here so the behaviour — and the single "you're approved" email — is
 * identical no matter where the admin clicked.
 *
 * The `isNull(approvedAt)` guard is the idempotency key: re-approving an already-approved account
 * flips nothing and sends no second email. Returns the row it actually flipped, or undefined when
 * there was no account, or it was already approved.
 */
async function approveExistingUser(
  email: string,
  adminId: string,
): Promise<{ id: string; email: string; approvedAt: Date | null } | undefined> {
  // Always ensure the email is invited (allowlisted) and drops off the access-requests list,
  // even when there's no account yet — this is what makes a future signup auto-approve.
  await db
    .insert(invitedEmails)
    .values({ email, invitedBy: adminId })
    .onConflictDoUpdate({ target: invitedEmails.email, set: { invitedBy: adminId } });
  await db.update(accessRequests).set({ status: "invited" }).where(eq(accessRequests.email, email));

  const [flipped] = await db
    .update(users)
    .set({ approvedAt: new Date(), approvedBy: adminId })
    .where(and(eq(users.email, email), isNull(users.approvedAt)))
    .returning({ id: users.id, email: users.email, approvedAt: users.approvedAt });

  if (flipped) {
    sendSystemMail({ to: flipped.email, ...accessApprovedEmail() }).catch((err) =>
      logger.error({ err, userId: flipped.id }, "failed to send access-approved email"),
    );
  }
  return flipped;
}

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/me", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return { isAdmin: true };
  });

  // Reports whether the Resend transport that sends all transactional email (signup
  // verification, password reset, access-approved) is configured — see lib/mailer.ts. In
  // development an unset key just logs mail to the console, so this only ever reports down
  // in production.
  app.get("/api/admin/mail-status", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const down = env.NODE_ENV === "production" && !env.RESEND_API_KEY;
    return { down, reason: down ? ("not_configured" as const) : null, invalidAt: null };
  });

  app.get("/api/admin/invites", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return db.select().from(invitedEmails).orderBy(desc(invitedEmails.invitedAt));
  });

  app.post("/api/admin/invites", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const body = addInviteSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();

    const [invite] = await db
      .insert(invitedEmails)
      .values({ email, note: body.note, invitedBy: userId })
      .onConflictDoUpdate({
        target: invitedEmails.email,
        set: { note: body.note, invitedBy: userId },
      })
      .returning();

    // Auto-approve any account already waiting for this email, and drop them off the
    // access-requests list. Exactly one email goes out per invite: if an existing pending
    // account was just approved, approveExistingUser already sent the "you're approved" mail;
    // otherwise (no account yet, or already approved) send the invitation with a signup link.
    const approved = await approveExistingUser(email, userId);
    if (!approved) {
      sendSystemMail({ to: email, ...inviteEmail() }).catch((err) =>
        logger.error({ err, email }, "failed to send invite email"),
      );
    }

    reply.status(201).send(invite);
  });

  app.delete("/api/admin/invites/:id", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    await db.delete(invitedEmails).where(eq(invitedEmails.id, id));
    reply.status(204).send();
  });

  app.get("/api/admin/access-requests", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return db.select().from(accessRequests).orderBy(desc(accessRequests.lastRequestedAt));
  });

  app.post("/api/admin/access-requests/:id/approve", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [requested] = await db.select().from(accessRequests).where(eq(accessRequests.id, id));
    if (!requested) {
      reply.status(404).send({ error: { message: "Access request not found", code: "NOT_FOUND" } });
      return;
    }

    // Approve any pending account for this email (sends the "you're approved" mail). If there's
    // no account yet — the common case, someone who was denied and hasn't registered — send them
    // the invitation instead, so approving from this list always notifies someone.
    const approved = await approveExistingUser(requested.email, userId);
    if (!approved) {
      sendSystemMail({ to: requested.email, ...inviteEmail() }).catch((err) =>
        logger.error({ err, email: requested.email }, "failed to send invite email"),
      );
    }

    const [updated] = await db
      .update(accessRequests)
      .set({ status: "invited" })
      .where(eq(accessRequests.id, id))
      .returning();
    return updated;
  });

  // --- Accounts ---
  //
  // The invite list only gates account CREATION, so removing an invite does nothing to an
  // account that already exists — revoking a real account happens here instead. Disabling is
  // reversible and keeps their data; deleting is not, and cascades to everything they own.

  app.get("/api/admin/users", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        disabledAt: users.disabledAt,
        approvedAt: users.approvedAt,
        emailVerifiedAt: users.emailVerifiedAt,
        signupSource: users.signupSource,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
  });

  app.post("/api/admin/users/:id/approve", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [target] = await db
      .select({ id: users.id, email: users.email, approvedAt: users.approvedAt })
      .from(users)
      .where(eq(users.id, id));
    if (!target) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    // Idempotent: approveExistingUser only flips a pending row and only emails when it does, so
    // approving an already-approved account (a double click, or overlap with the access-requests
    // list) is a no-op that returns the current row without re-sending the approval email.
    const flipped = await approveExistingUser(target.email, userId);
    return { id: target.id, email: target.email, approvedAt: flipped?.approvedAt ?? target.approvedAt };
  });

  app.post("/api/admin/users/:id/unapprove", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (id === userId) {
      reply.status(400).send({
        error: { message: "You can't unapprove your own account", code: "SELF_TARGET" },
      });
      return;
    }
    if (!(await loadDestructibleUser(id, reply))) return;

    const [updated] = await db
      .update(users)
      .set({ approvedAt: null, approvedBy: null })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, approvedAt: users.approvedAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  // Escape hatch for when the verification email couldn't be sent (see systemMail.ts /
  // MailTransportDownError) — lets an admin unblock a signup by hand instead of the user
  // being stuck forever without a working mail transport.
  app.post("/api/admin/users/:id/verify-email", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [updated] = await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  app.post("/api/admin/users/:id/disable", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (id === userId) {
      reply.status(400).send({
        error: { message: "You can't disable your own account", code: "SELF_TARGET" },
      });
      return;
    }
    if (!(await loadDestructibleUser(id, reply))) return;

    const [updated] = await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, disabledAt: users.disabledAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  app.post("/api/admin/users/:id/enable", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [updated] = await db
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, disabledAt: users.disabledAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (id === userId) {
      reply.status(400).send({
        error: { message: "You can't delete your own account", code: "SELF_TARGET" },
      });
      return;
    }

    const target = await loadDestructibleUser(id, reply);
    if (!target) return;

    // Drop the invite too, otherwise the same email can immediately sign up again and the
    // delete reads as a no-op.
    await db.delete(invitedEmails).where(eq(invitedEmails.email, target.email));
    await db.delete(users).where(eq(users.id, id));
    reply.status(204).send();
  });

  app.delete("/api/admin/access-requests/:id", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [updated] = await db
      .update(accessRequests)
      .set({ status: "dismissed" })
      .where(eq(accessRequests.id, id))
      .returning();
    if (!updated) {
      reply.status(404).send({ error: { message: "Access request not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });
}
