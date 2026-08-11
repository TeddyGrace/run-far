import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { buildAuthorizeUrl, exchangeCodeAndStore } from "../integrations/google/oauth.js";
import { ensureRunningCalendar } from "../integrations/google/calendarClient.js";
import { registerWatch } from "../integrations/google/channelRenewal.js";
import { pullGoogleCalendarChanges } from "../integrations/google/pull.js";
import { db } from "../db/client.js";
import { oauthConnections } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";

const OAUTH_STATE_COOKIE = "google_oauth_state";

export async function googleRoutes(app: FastifyInstance) {
  app.get("/api/google/oauth/start", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const state = randomBytes(16).toString("hex");
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    reply.redirect(buildAuthorizeUrl(state));
  });

  app.get("/api/google/oauth/callback", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const { code, state } = request.query as { code?: string; state?: string };
    const expectedState = request.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

    if (!code || !state || state !== expectedState) {
      reply.status(400).send({ error: "invalid oauth state or missing code" });
      return;
    }

    await exchangeCodeAndStore(userId, code);
    await ensureRunningCalendar(userId);

    // Push notifications need a public HTTPS URL; skip registering a watch channel if
    // none is configured (dev without a tunnel). Sync still works via manual/nightly pulls.
    if (env.GOOGLE_WEBHOOK_URL) {
      registerWatch(userId).catch((err) =>
        logger.error({ err, userId }, "failed to register google watch channel"),
      );
    }
    pullGoogleCalendarChanges(userId).catch((err) =>
      logger.error({ err, userId }, "initial google calendar pull failed"),
    );

    reply.redirect(`${env.WEB_ORIGIN}/settings?connected=google`);
  });

  app.get("/api/google/status", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [conn] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));

    return {
      provider: "google",
      connected: Boolean(conn),
      scopes: conn?.scopes ?? [],
      lastSyncedAt: null,
    };
  });

  // Manual trigger, useful for dev without a public webhook URL / tunnel.
  app.post("/api/google/sync", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    await pullGoogleCalendarChanges(userId);
    return { ok: true };
  });
}
