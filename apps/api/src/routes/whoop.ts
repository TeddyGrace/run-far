import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { buildAuthorizeUrl, exchangeCodeAndStore } from "../integrations/whoop/oauth.js";
import { backfillWhoop } from "../integrations/whoop/sync.js";
import { whoopGet } from "../integrations/whoop/client.js";
import { db } from "../db/client.js";
import { oauthConnections, syncState } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { cookieOpts } from "../lib/cookies.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";

const OAUTH_STATE_COOKIE = "whoop_oauth_state";

async function captureWhoopUserId(userId: string): Promise<void> {
  const profile = await whoopGet<{ user_id: number }>(userId, "/v2/user/profile/basic");
  await db
    .update(oauthConnections)
    .set({ metadata: { whoopUserId: profile.user_id } })
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop")));
}

export async function whoopRoutes(app: FastifyInstance) {
  app.get("/api/whoop/oauth/start", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const { url, state } = buildAuthorizeUrl();
    reply.setCookie(OAUTH_STATE_COOKIE, state, cookieOpts({ maxAge: 600 }));
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
    // can be routed back to this app user once a public webhook URL is configured.
    try {
      await captureWhoopUserId(userId);
    } catch (err) {
      logger.error({ err, userId }, "failed to capture whoop user id after connect");
    }

    // Fire-and-forget on connect so the redirect isn't blocked; Settings → Sync now
    // is the reliable path while webhooks aren't hosted yet.
    backfillWhoop(userId).catch((err) => logger.error({ err, userId }, "whoop backfill failed"));

    reply.redirect(`${env.WEB_ORIGIN}/settings?connected=whoop`);
  });

  app.get("/api/whoop/status", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [conn] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop")));

    const [state] = await db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "whoop")));

    return {
      provider: "whoop",
      connected: Boolean(conn),
      scopes: conn?.scopes ?? [],
      lastSyncedAt: state?.lastPolledAt?.toISOString() ?? null,
    };
  });

  // Manual backfill — primary sync path in local/dev without a public Whoop webhook URL.
  app.post("/api/whoop/sync", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [conn] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop")));
    if (!conn) {
      reply.status(400).send({ error: { message: "Whoop is not connected", code: "WHOOP_NOT_CONNECTED" } });
      return;
    }

    try {
      const meta = conn.metadata as { whoopUserId?: number } | null;
      if (!meta?.whoopUserId) {
        await captureWhoopUserId(userId);
      }
      await backfillWhoop(userId);
    } catch (err) {
      logger.error({ err, userId }, "manual whoop sync failed");
      reply.status(502).send({
        error: {
          message: err instanceof Error ? err.message : "Whoop sync failed",
          code: "WHOOP_SYNC_FAILED",
        },
      });
      return;
    }

    const [state] = await db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "whoop")));

    return { ok: true, lastSyncedAt: state?.lastPolledAt?.toISOString() ?? null };
  });
}
