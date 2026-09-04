import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  users,
  oauthConnections,
  trainingPlans,
  plannedRuns,
  recoveryMetrics,
  sleepRecords,
  whoopWorkouts,
  cycles,
  recommendations,
  chatSessions,
  chatMessages,
  invitedEmails,
  accessRequests,
} from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { verifyPassword } from "../lib/auth.js";
import { normalizeEmail } from "../lib/email.js";
import { clearSessionCookie } from "../lib/session.js";
import { decryptSecret } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";
import { isStripeConfigured, stripeClient } from "../integrations/stripe/client.js";

/** Account deletion is irreversible and cascades everything, so it takes a second proof the
 * person at the keyboard owns the account — not just a live session cookie. Password accounts
 * re-enter their password; Google-only accounts (passwordHash null, nothing to re-enter) type
 * their own email address instead. */
const deleteAccountSchema = z.object({
  password: z.string().optional(),
  confirmEmail: z.string().optional(),
});

/** Best-effort — a failed revoke never blocks account deletion. Once we delete our own copy
 * of the token below, it's practically inert either way; this just also clears it from the
 * athlete's Google Account permissions page. */
async function revokeGoogleGrant(refreshTokenEnc: string): Promise<void> {
  try {
    const token = decryptSecret(refreshTokenEnc);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch (err) {
    logger.warn({ err }, "failed to revoke google oauth grant on account deletion");
  }
}

/** Best-effort, same reasoning as revokeGoogleGrant. */
async function revokeWhoopGrant(accessTokenEnc: string): Promise<void> {
  try {
    const token = decryptSecret(accessTokenEnc);
    await fetch("https://api.prod.whoop.com/oauth/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        client_id: env.WHOOP_CLIENT_ID,
        client_secret: env.WHOOP_CLIENT_SECRET,
      }),
    });
  } catch (err) {
    logger.warn({ err }, "failed to revoke whoop oauth grant on account deletion");
  }
}

export async function accountRoutes(app: FastifyInstance) {
  // Registered in UNENTITLED_ALLOWED_PATHS (lib/activeUser.ts) — a lapsed or never-subscribed
  // user must still be able to get their data out and close their account.

  app.get("/api/account/export", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const sessions = await db.select().from(chatSessions).where(eq(chatSessions.userId, userId));
    const sessionIds = sessions.map((s) => s.id);

    const [
      plans,
      runs,
      recovery,
      sleep,
      workouts,
      cyclesRows,
      recs,
      messages,
    ] = await Promise.all([
      db.select().from(trainingPlans).where(eq(trainingPlans.userId, userId)),
      db.select().from(plannedRuns).where(eq(plannedRuns.userId, userId)),
      db.select().from(recoveryMetrics).where(eq(recoveryMetrics.userId, userId)),
      db.select().from(sleepRecords).where(eq(sleepRecords.userId, userId)),
      db.select().from(whoopWorkouts).where(eq(whoopWorkouts.userId, userId)),
      db.select().from(cycles).where(eq(cycles.userId, userId)),
      db.select().from(recommendations).where(eq(recommendations.userId, userId)),
      sessionIds.length > 0
        ? db.select().from(chatMessages).where(inArray(chatMessages.sessionId, sessionIds))
        : Promise.resolve([]),
    ]);

    reply.header("Content-Disposition", `attachment; filename="run-far-export-${userId}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      trainingPlans: plans,
      plannedRuns: runs,
      recoveryMetrics: recovery,
      sleepRecords: sleep,
      whoopWorkouts: workouts,
      cycles: cyclesRows,
      recommendations: recs,
      chatSessions: sessions,
      chatMessages: messages,
    };
  });

  app.delete("/api/account", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    // Mirrors the admin-target guard in routes/admin.ts loadDestructibleUser — deleting the
    // last admin would permanently orphan the backoffice.
    if (user.role === "admin") {
      reply.status(403).send({
        error: { message: "Admin accounts can't self-delete — ask another admin.", code: "ADMIN_TARGET" },
      });
      return;
    }

    const body = deleteAccountSchema.parse(request.body ?? {});
    if (user.passwordHash) {
      if (!body.password || !(await verifyPassword(body.password, user.passwordHash))) {
        reply.status(401).send({
          error: { message: "That password is incorrect.", code: "INVALID_PASSWORD" },
        });
        return;
      }
    } else if (normalizeEmail(body.confirmEmail ?? "") !== user.email) {
      reply.status(400).send({
        error: { message: "Type your email address exactly to confirm.", code: "CONFIRM_EMAIL_MISMATCH" },
      });
      return;
    }

    if (isStripeConfigured() && user.stripeSubscriptionId) {
      try {
        await stripeClient().subscriptions.cancel(user.stripeSubscriptionId);
      } catch (err) {
        logger.warn({ err, userId }, "failed to cancel stripe subscription on account deletion");
      }
    }

    const connections = await db.select().from(oauthConnections).where(eq(oauthConnections.userId, userId));
    for (const conn of connections) {
      if (conn.provider === "google") await revokeGoogleGrant(conn.refreshTokenEnc);
      if (conn.provider === "whoop") await revokeWhoopGrant(conn.accessTokenEnc);
    }

    // Cascades to every table with a userId -> users FK (plans, runs, recovery data, chat,
    // oauth connections, sync state, etc) — see the onDelete: "cascade" references in
    // db/schema.ts. Same one-statement pattern as the admin delete route.
    await db.delete(users).where(eq(users.id, userId));
    // Keyed by email rather than user id, so they survive the cascade — mirrors the cleanup in
    // routes/admin.ts's delete handler. Without this a deleted athlete's leftover invite would
    // silently auto-comp them again if they ever signed up afresh (see shouldAutoComp).
    await db.delete(invitedEmails).where(eq(invitedEmails.email, user.email));
    await db.delete(accessRequests).where(eq(accessRequests.email, user.email));

    clearSessionCookie(reply);
    return { ok: true };
  });
}
