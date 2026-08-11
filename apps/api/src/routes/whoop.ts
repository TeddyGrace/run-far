import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { buildAuthorizeUrl, exchangeCodeAndStore } from "../integrations/whoop/oauth.js";
import { backfillWhoop } from "../integrations/whoop/sync.js";
import { whoopGet } from "../integrations/whoop/client.js";
import { db } from "../db/client.js";
import { oauthConnections } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { logger } from "../lib/logger.js";

const OAUTH_STATE_COOKIE = "whoop_oauth_state";

export async function whoopRoutes(app: FastifyInstance) {
  app.get("/api/whoop/oauth/start", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const { url, state } = buildAuthorizeUrl();
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    reply.redirect(url);
  });

  app.get("/api/whoop/oauth/callback", async (request, reply) => {
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

    // Capture the Whoop-side user id so incoming webhooks (which only carry that id)
    // can be routed back to this app user.
    try {
      const profile = await whoopGet<{ user_id: number }>(userId, "/v2/user/profile/basic");
      await db
        .update(oauthConnections)
        .set({ metadata: { whoopUserId: profile.user_id } })
        .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop")));
    } catch (err) {
      logger.error({ err, userId }, "failed to capture whoop user id after connect");
    }

    backfillWhoop(userId).catch((err) => logger.error({ err, userId }, "whoop backfill failed"));

    reply.redirect(`${process.env.WEB_ORIGIN ?? "http://localhost:5173"}/settings?connected=whoop`);
  });

  app.get("/api/whoop/status", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [conn] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop")));

    return {
      provider: "whoop",
      connected: Boolean(conn),
      scopes: conn?.scopes ?? [],
      lastSyncedAt: null,
    };
  });
}
