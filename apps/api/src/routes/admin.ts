import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { invitedEmails, accessRequests, users, aiUsage } from "../db/schema.js";
import { requireAdminUserId } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";
import { isStripeConfigured, stripeClient } from "../integrations/stripe/client.js";
import { applyStripeSubscription } from "../integrations/stripe/entitlement.js";
import { sendSystemMail } from "../lib/systemMail.js";
import { accessApprovedEmail, inviteEmail } from "../lib/emailTemplates.js";

const addInviteSchema = z.object({
  email: z.string().email(),
  note: z.string().trim().max(500).optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });
const compRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

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
 * surfaces in sync. Every approval path (invite creation, the users list) funnels through here so
 * the behaviour — and the single "you're approved" email — is identical no matter where the admin
 * clicked.
 *
 * The `isNull(approvedAt)` guard is the idempotency key: re-approving an already-approved account
 * flips nothing and sends no second email. Returns the row it actually flipped, or undefined when
 * there was no account, or it was already approved.
 */
async function approveExistingUser(
  email: string,
  adminId: string,
): Promise<{ id: string; email: string; approvedAt: Date | null } | undefined> {
  // Always ensure the email is invited (allowlisted) and drops off the access-requests review
  // queue, even when there's no account yet — this is what makes a future signup auto-approve.
  await db
    .insert(invitedEmails)
    .values({ email, invitedBy: adminId })
    .onConflictDoUpdate({ target: invitedEmails.email, set: { invitedBy: adminId } });
  await db.update(accessRequests).set({ status: "invited" }).where(eq(accessRequests.email, email));

  // approvedAt no longer gates access (see lib/entitlement.ts / activeUserGuard) — an invite
  // now grants entitlement directly, as a comp, so this stays the working "give this person
  // free access" action rather than becoming a no-op once open signup ships.
  const [flipped] = await db
    .update(users)
    .set({
      approvedAt: new Date(),
      approvedBy: adminId,
      entitlementSource: "comp",
      entitlementStatus: "active",
      // Cleared, not left as-is: a comp is open-ended, and a stale expiry left over from a
      // lapsed Stripe subscription would make resolveEntitlement treat this comp as expired.
      entitlementExpiresAt: null,
      compedAt: new Date(),
      compedBy: adminId,
    })
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
    // hasAccount lets the backoffice hide invites that already turned into an account — the
    // invite list's job is "who may sign up", not a permanent log of who was ever approved.
    const rows = await db
      .select({
        id: invitedEmails.id,
        email: invitedEmails.email,
        note: invitedEmails.note,
        invitedBy: invitedEmails.invitedBy,
        invitedAt: invitedEmails.invitedAt,
        hasAccount: sql<boolean>`(${users.id} is not null)`,
      })
      .from(invitedEmails)
      .leftJoin(users, eq(users.email, invitedEmails.email))
      .orderBy(desc(invitedEmails.invitedAt));
    return rows;
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
    // access-requests review queue. Exactly one email goes out per invite: if an existing
    // pending account was just approved, approveExistingUser already sent the "you're
    // approved" mail; otherwise (no account yet, or already approved) send the invitation
    // with a signup link.
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

  // --- Accounts ---
  //
  // The invite list only gates account CREATION, so removing an invite does nothing to an
  // account that already exists — revoking a real account happens here instead. Disabling is
  // reversible and keeps their data; deleting is not, and cascades to everything they own.
  //
  // Entitlement and month-to-date AI cost are joined in so the backoffice can show, per row,
  // whether someone has access and what they're costing — the two things that decide whether
  // to comp, un-comp, or investigate an account.

  app.get("/api/admin/users", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);
    // Aggregated separately and left-joined rather than grouping the whole query by every
    // users column — keeps this a simple one-row-per-user list even as ai_usage grows.
    const usageThisMonth = db
      .select({
        userId: aiUsage.userId,
        spentMicros: sql<number>`sum(${aiUsage.estimatedCostMicros})::integer`.as("spent_micros"),
      })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, startOfMonth))
      .groupBy(aiUsage.userId)
      .as("usage_this_month");

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
        entitlementSource: users.entitlementSource,
        entitlementStatus: users.entitlementStatus,
        entitlementExpiresAt: users.entitlementExpiresAt,
        compedAt: users.compedAt,
        compNote: users.compNote,
        aiUsageThisMonthMicros: sql<number>`coalesce(${usageThisMonth.spentMicros}, 0)::integer`,
      })
      .from(users)
      .leftJoin(usageThisMonth, eq(usageThisMonth.userId, users.id))
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
    // approving an already-approved account (a double click) is a no-op that returns the current
    // row without re-sending the approval email.
    const flipped = await approveExistingUser(target.email, userId);
    return { id: target.id, email: target.email, approvedAt: flipped?.approvedAt ?? target.approvedAt };
  });

  // Denies a pending signup: disables the account (so it can't sign in) without ever approving
  // it, drops it off the review queue (dismissed on the access-requests log, invite removed so
  // it isn't silently re-allowlisted), while keeping the row itself around under Accounts.
  app.post("/api/admin/users/:id/deny", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (id === userId) {
      reply.status(400).send({
        error: { message: "You can't deny your own account", code: "SELF_TARGET" },
      });
      return;
    }
    const target = await loadDestructibleUser(id, reply);
    if (!target) return;

    const [updated] = await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, disabledAt: users.disabledAt, approvedAt: users.approvedAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    await db.update(accessRequests).set({ status: "dismissed" }).where(eq(accessRequests.email, target.email));
    await db.delete(invitedEmails).where(eq(invitedEmails.email, target.email));
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

    const [target] = await db.select({ entitlementSource: users.entitlementSource }).from(users).where(eq(users.id, id));
    // Only undo what approve/invite granted (a comp) — never touch a real Stripe subscription
    // this action didn't create. A paying user with a stray null approvedAt (they never went
    // through the invite flow) keeps their access.
    const wasComped = target?.entitlementSource === "comp";

    const [updated] = await db
      .update(users)
      .set({
        approvedAt: null,
        approvedBy: null,
        ...(wasComped
          ? { entitlementSource: null, entitlementStatus: "none" as const, compedAt: null, compedBy: null }
          : {}),
      })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, approvedAt: users.approvedAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  // --- Comps ---
  //
  // The direct "grant this specific account free access" switch — independent of the
  // invite/approve flow above (which is really "let this email sign up and start comped").
  // Use this on an account that already exists, invited or not, self-signed-up or not, even
  // one with a live Stripe subscription (comp still wins — see lib/entitlement.ts).

  app.post("/api/admin/users/:id/comp", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const body = compRequestSchema.parse(request.body ?? {});
    if (!(await loadDestructibleUser(id, reply))) return;

    const [updated] = await db
      .update(users)
      .set({
        entitlementSource: "comp",
        entitlementStatus: "active",
        // See approveExistingUser above — a comp granted to someone whose Stripe subscription
        // already lapsed has to clear that old expiry, or resolveEntitlement reads the comp as
        // already expired and the athlete stays paywalled despite this returning 200.
        entitlementExpiresAt: null,
        compedAt: new Date(),
        compedBy: userId,
        compNote: body.note ?? null,
      })
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        entitlementSource: users.entitlementSource,
        entitlementStatus: users.entitlementStatus,
        compedAt: users.compedAt,
        compNote: users.compNote,
      });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  // Clears a comp only — a user with an active Stripe subscription keeps it; this just stops
  // the free-access override, same as unapprove above but reachable regardless of how the
  // comp was granted (invite flow or this endpoint).
  app.delete("/api/admin/users/:id/comp", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (!(await loadDestructibleUser(id, reply))) return;

    const [updated] = await db
      .update(users)
      .set({
        entitlementSource: null,
        entitlementStatus: "none",
        compedAt: null,
        compedBy: null,
        compNote: null,
      })
      .where(and(eq(users.id, id), eq(users.entitlementSource, "comp")))
      .returning({
        id: users.id,
        email: users.email,
        entitlementSource: users.entitlementSource,
        stripeSubscriptionId: users.stripeSubscriptionId,
      });
    if (!updated) {
      reply.status(404).send({
        error: { message: "User not found, or not currently comped", code: "NOT_FOUND" },
      });
      return;
    }

    // A comped athlete who also subscribed had their Stripe status recorded but not applied
    // (integrations/stripe/entitlement.ts refuses to overwrite a comp). Clearing the comp is
    // the moment that subscription should take over — without this re-sync they'd sit at
    // "none", paywalled while paying, until Stripe's next webhook at renewal.
    if (updated.stripeSubscriptionId && isStripeConfigured()) {
      try {
        const subscription = await stripeClient().subscriptions.retrieve(updated.stripeSubscriptionId);
        await applyStripeSubscription(subscription, new Date());
      } catch (err) {
        logger.warn({ err, userId: id }, "failed to re-sync stripe subscription after un-comp");
      }
    }

    const [after] = await db
      .select({ id: users.id, email: users.email, entitlementSource: users.entitlementSource })
      .from(users)
      .where(eq(users.id, id));
    return after ?? { id: updated.id, email: updated.email, entitlementSource: updated.entitlementSource };
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

    // Drop the invite and access-request log too, otherwise the same email can immediately
    // sign up again and either the delete reads as a no-op (invite) or the re-signup inherits
    // a stale status like "dismissed" (access request).
    await db.delete(invitedEmails).where(eq(invitedEmails.email, target.email));
    await db.delete(accessRequests).where(eq(accessRequests.email, target.email));
    await db.delete(users).where(eq(users.id, id));
    reply.status(204).send();
  });
}
