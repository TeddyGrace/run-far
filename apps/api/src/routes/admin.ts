import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { invitedEmails, accessRequests, users, aiUsage, appSettings } from "../db/schema.js";
import { requireAdminUserId } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";
import { isStripeConfigured, stripeClient } from "../integrations/stripe/client.js";
import { applyStripeSubscription } from "../integrations/stripe/entitlement.js";
import { sendSystemMail } from "../lib/systemMail.js";
import { accessApprovedEmail, inviteEmail } from "../lib/emailTemplates.js";
import { APP_SETTINGS_ID, loadAppSettings } from "../lib/modelRendering.js";

const addInviteSchema = z.object({
  email: z.string().email(),
  note: z.string().trim().max(500).optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });
const compRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
const appSettingsPatchSchema = z.object({
  modelRenderedDefault: z.boolean(),
});
const modelRenderingSchema = z.object({
  // Explicitly boolean: clearing an override back to "inherit" is DELETE, not a null here, so
  // that "off" and "not set" stay distinguishable at the API boundary too.
  rendered: z.boolean(),
});

/**
 * Loads the target of a destructive account action, refusing it outright when that account is
 * an admin. `role` is granted only by data migration (drizzle/0018_handy_maddog.sql) and by no
 * app route, so an admin that gets deleted — or locked out via disable — can't be
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
        message: "Admin accounts can't be deleted, disabled, or have access revoked",
        code: "ADMIN_TARGET",
      },
    });
    return undefined;
  }
  return target;
}

/**
 * Grants free access (a comp) to whatever account exists for `email`, idempotently, and adds
 * the email to the invite allowlist. Both invite surfaces funnel through here so the
 * behaviour — and the single "you're in" email — is identical however the admin got here.
 *
 * The `isNull(compedAt)` guard is the idempotency key: re-inviting an already-comped account
 * grants nothing again and sends no second email. The three outcomes are distinguished so the
 * caller knows which mail to send — only a genuinely new email gets the signup invitation.
 */
type InviteOutcome = "granted" | "already-had-access" | "no-account";

async function grantInviteComp(email: string, adminId: string): Promise<InviteOutcome> {
  // Allowlist the email even when there's no account yet — that is what makes a future signup
  // start out with free access (see shouldAutoComp in routes/auth.ts). Signup itself is open
  // to everyone; the allowlist only decides who skips the paywall.
  await db
    .insert(invitedEmails)
    .values({ email, invitedBy: adminId })
    .onConflictDoUpdate({ target: invitedEmails.email, set: { invitedBy: adminId } });

  const [granted] = await db
    .update(users)
    .set({
      entitlementSource: "comp",
      entitlementStatus: "active",
      // Cleared, not left as-is: free access is open-ended, and a stale expiry left over from
      // a lapsed Stripe subscription would make resolveEntitlement treat this comp as expired.
      entitlementExpiresAt: null,
      compedAt: new Date(),
      compedBy: adminId,
    })
    .where(and(eq(users.email, email), isNull(users.compedAt)))
    .returning({ id: users.id, email: users.email });

  if (granted) {
    sendSystemMail({ to: granted.email, ...accessApprovedEmail() }).catch((err) =>
      logger.error({ err, userId: granted.id }, "failed to send free-access email"),
    );
    return "granted";
  }

  // No grant happened, for one of two very different reasons: either there is nobody to grant
  // to yet, or they already have free access. Only the first should get a signup invitation.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return existing ? "already-had-access" : "no-account";
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
    // list's job is "who is still waiting to sign up", not a log of everyone ever granted
    // free access.
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

    // At most one email goes out per invite. A brand-new email gets the invitation with a
    // signup link; an account that was just granted free access already got the "you're in"
    // mail from grantInviteComp; and re-inviting someone who already has access gets nothing,
    // rather than a signup link for the account they're already using.
    if ((await grantInviteComp(email, userId)) === "no-account") {
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
  // The invite list only decides who starts out with free access, so removing an invite does
  // nothing to an account that already exists — revoking real access happens here instead.
  // Disabling is reversible and keeps their data; deleting is not, and cascades to everything
  // they own.
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
        emailVerifiedAt: users.emailVerifiedAt,
        signupSource: users.signupSource,
        createdAt: users.createdAt,
        entitlementSource: users.entitlementSource,
        entitlementStatus: users.entitlementStatus,
        entitlementExpiresAt: users.entitlementExpiresAt,
        compedAt: users.compedAt,
        compNote: users.compNote,
        modelRenderedOverride: users.modelRenderedOverride,
        aiUsageThisMonthMicros: sql<number>`coalesce(${usageThisMonth.spentMicros}, 0)::integer`,
      })
      .from(users)
      .leftJoin(usageThisMonth, eq(usageThisMonth.userId, users.id))
      .orderBy(desc(users.createdAt));
  });

  // --- Comps ---
  //
  // The direct "grant this specific account free access" switch — the same grant the invite
  // flow above applies at signup, but reachable for any account that already exists: invited
  // or not, self-signed-up or not, even one with a live Stripe subscription (comp still wins —
  // see lib/entitlement.ts).

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
        // See grantInviteComp above — free access granted to someone whose Stripe subscription
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
  // the free-access override, however it was granted (invite flow or this endpoint).
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

  // --- Recommendation engine ---
  //
  // Which recommendation sources athletes actually see. The model source runs and is scored in
  // shadow on every ingestion event regardless of these switches — they gate *rendering* only,
  // which is what makes it safe to evaluate a candidate model on live data before showing it to
  // anyone. See lib/modelRendering.ts for how the global default and per-account overrides
  // resolve, and recommendations/sources/ for what a source is.

  app.get("/api/admin/settings", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return loadAppSettings();
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const body = appSettingsPatchSchema.parse(request.body ?? {});
    // Upsert rather than update: the migration seeds the singleton row, but a database restored
    // or created by some other path shouldn't leave this endpoint silently writing nothing.
    const [row] = await db
      .insert(appSettings)
      .values({
        id: APP_SETTINGS_ID,
        modelRenderedDefault: body.modelRenderedDefault,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: appSettings.id,
        set: {
          modelRenderedDefault: body.modelRenderedDefault,
          updatedAt: new Date(),
          updatedBy: userId,
        },
      })
      .returning({
        modelRenderedDefault: appSettings.modelRenderedDefault,
        updatedAt: appSettings.updatedAt,
      });
    logger.info(
      { adminId: userId, modelRenderedDefault: body.modelRenderedDefault },
      "app settings updated",
    );
    return row;
  });

  /** Pins one account on or off, overriding the global default in either direction. */
  app.post("/api/admin/users/:id/model-rendering", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const body = modelRenderingSchema.parse(request.body ?? {});
    return updateModelRenderingOverride(id, body.rendered, reply);
  });

  /** Clears the override, returning the account to the global default. */
  app.delete("/api/admin/users/:id/model-rendering", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    return updateModelRenderingOverride(id, null, reply);
  });
}

/** Shared by the set/clear endpoints above — null means "inherit the global default". */
async function updateModelRenderingOverride(
  id: string,
  value: boolean | null,
  reply: FastifyReply,
) {
  const [updated] = await db
    .update(users)
    .set({ modelRenderedOverride: value })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
      modelRenderedOverride: users.modelRenderedOverride,
    });
  if (!updated) {
    reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
    return;
  }
  return updated;
}
