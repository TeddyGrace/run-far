import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { invitedEmails, accessRequests, users } from "../db/schema.js";
import { requireAdminUserId } from "../lib/adminAuth.js";
import { sendSystemMail } from "../lib/systemMail.js";
import { accessApprovedEmail } from "../lib/emailTemplates.js";
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

    // Someone who already tried and was denied should drop off the access-requests list
    // once they're invited.
    await db
      .update(accessRequests)
      .set({ status: "invited" })
      .where(eq(accessRequests.email, email));

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

    await db
      .insert(invitedEmails)
      .values({ email: requested.email, invitedBy: userId })
      .onConflictDoUpdate({
        target: invitedEmails.email,
        set: { invitedBy: userId },
      });

    // Keep the two approval surfaces in sync: an email approved here may already have a
    // pending users row (e.g. a password signup) that's still waiting on approvedAt.
    const [pendingUser] = await db
      .update(users)
      .set({ approvedAt: new Date(), approvedBy: userId })
      .where(and(eq(users.email, requested.email), isNull(users.approvedAt)))
      .returning({ id: users.id, email: users.email });
    if (pendingUser) {
      sendSystemMail({ to: pendingUser.email, ...accessApprovedEmail() }).catch((err) =>
        logger.error({ err, userId: pendingUser.id }, "failed to send access-approved email"),
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
    const [updated] = await db
      .update(users)
      .set({ approvedAt: new Date(), approvedBy: userId })
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        approvedAt: users.approvedAt,
      });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    await db
      .insert(invitedEmails)
      .values({ email: updated.email, invitedBy: userId })
      .onConflictDoUpdate({ target: invitedEmails.email, set: { invitedBy: userId } });
    await db
      .update(accessRequests)
      .set({ status: "invited" })
      .where(eq(accessRequests.email, updated.email));

    sendSystemMail({ to: updated.email, ...accessApprovedEmail() }).catch((err) =>
      logger.error({ err, userId: updated.id }, "failed to send access-approved email"),
    );

    return updated;
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
