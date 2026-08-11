import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../lib/auth.js";
import { setSessionCookie, clearSessionCookie, requireUserId } from "../lib/session.js";
import { cookieOpts } from "../lib/cookies.js";
import {
  buildGoogleLoginAuthorizeUrl,
  exchangeGoogleLoginCode,
  LOGIN_SCOPES,
} from "../integrations/google/authOauth.js";
import { persistGoogleTokens } from "../integrations/google/oauth.js";
import { ensureRunningCalendar } from "../integrations/google/calendarClient.js";
import { registerWatch } from "../integrations/google/channelRenewal.js";
import { pullGoogleCalendarChanges } from "../integrations/google/pull.js";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const OAUTH_STATE_COOKIE = "google_login_oauth_state";
const CONSENT_RETRY_COOKIE = "google_login_consent_retry";

async function findOrCreateGoogleUser(identity: {
  sub: string;
  email: string;
}): Promise<typeof users.$inferSelect> {
  const [bySub] = await db.select().from(users).where(eq(users.googleSub, identity.sub));
  if (bySub) return bySub;

  const [byEmail] = await db.select().from(users).where(eq(users.email, identity.email));
  if (byEmail) {
    const [linked] = await db
      .update(users)
      .set({ googleSub: identity.sub })
      .where(eq(users.id, byEmail.id))
      .returning();
    if (!linked) throw new Error("failed to link google sub to existing user");
    return linked;
  }

  const [created] = await db
    .insert(users)
    .values({
      email: identity.email,
      googleSub: identity.sub,
      passwordHash: null,
    })
    .returning();
  if (!created) throw new Error("failed to create google user");
  return created;
}

/** Calendar setup after sign-in. Runs in the background so login isn't blocked on it. */
async function setUpCalendar(userId: string): Promise<void> {
  await ensureRunningCalendar(userId);

  // Push notifications need a public HTTPS URL; without one, sync falls back to
  // manual and periodic pulls.
  if (env.GOOGLE_WEBHOOK_URL) {
    registerWatch(userId).catch((err) =>
      logger.error({ err, userId }, "failed to register google watch channel"),
    );
  }
  await pullGoogleCalendarChanges(userId);
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      reply.status(401).send({ error: { message: "Invalid credentials", code: "INVALID_LOGIN" } });
      return;
    }
    setSessionCookie(reply, user.id);
    return { id: user.id, email: user.email };
  });

  app.get("/api/auth/google/start", async (request, reply) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      reply.status(503).send({
        error: {
          message: "Google Sign-In is not configured",
          code: "GOOGLE_AUTH_NOT_CONFIGURED",
        },
      });
      return;
    }

    const { consent } = request.query as { consent?: string };
    const forceConsent = consent === "1";

    const state = randomBytes(16).toString("hex");
    reply.setCookie(OAUTH_STATE_COOKIE, state, cookieOpts({ maxAge: 600 }));
    if (forceConsent) {
      reply.setCookie(CONSENT_RETRY_COOKIE, "1", cookieOpts({ maxAge: 600 }));
    }
    reply.redirect(buildGoogleLoginAuthorizeUrl(state, forceConsent));
  });

  app.get("/api/auth/google/callback", async (request, reply) => {
    const { code, state, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    const expectedState = request.cookies[OAUTH_STATE_COOKIE];
    const isConsentRetry = request.cookies[CONSENT_RETRY_COOKIE] === "1";
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
    reply.clearCookie(CONSENT_RETRY_COOKIE, { path: "/" });

    if (error) {
      logger.warn({ error }, "google login denied");
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_denied`);
      return;
    }

    if (!code || !state || state !== expectedState) {
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_invalid`);
      return;
    }

    try {
      const { identity, tokens } = await exchangeGoogleLoginCode(code);
      const user = await findOrCreateGoogleUser(identity);
      setSessionCookie(reply, user.id);

      const connected = await persistGoogleTokens(user.id, tokens, LOGIN_SCOPES);
      if (!connected) {
        // Google withheld a refresh token and we have none stored. One forced-consent
        // round trip fixes it; if that already happened, sign in without Calendar.
        if (!isConsentRetry) {
          reply.redirect("/api/auth/google/start?consent=1");
          return;
        }
        logger.warn({ userId: user.id }, "signed in without a google refresh token");
        reply.redirect(`${env.WEB_ORIGIN}/settings?error=google_calendar`);
        return;
      }

      setUpCalendar(user.id).catch((err) =>
        logger.error({ err, userId: user.id }, "google calendar setup after login failed"),
      );

      reply.redirect(`${env.WEB_ORIGIN}/`);
    } catch (err) {
      logger.error({ err }, "google login failed");
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_failed`);
    }
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      reply.status(401).send({ error: { message: "User no longer exists", code: "UNAUTHENTICATED" } });
      return;
    }
    return { id: user.id, email: user.email };
  });
}
