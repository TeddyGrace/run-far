import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { setPasswordSchema } from "@run-far/shared";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/auth.js";
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

/** Thrown when a brand-new email tries to create an account but isn't on ALLOWED_EMAILS.
 * Never thrown for an existing user (sub or email match) — the allowlist only gates creation. */
class NotInvitedError extends Error {
  constructor(readonly email: string) {
    super(`email not on allowlist: ${email}`);
  }
}

function isEmailAllowedToSignUp(email: string): boolean {
  if (env.allowedEmails.size > 0) return env.allowedEmails.has(email.toLowerCase());
  // No allowlist configured: fail closed in production, open in dev so a fresh checkout
  // still works without env setup.
  return env.NODE_ENV !== "production";
}

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

  if (!isEmailAllowedToSignUp(identity.email)) {
    throw new NotInvitedError(identity.email);
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
    return { id: user.id, email: user.email, timezone: user.timezone };
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
      if (err instanceof NotInvitedError) {
        reply.redirect(`${env.WEB_ORIGIN}/access-requested?email=${encodeURIComponent(err.email)}`);
        return;
      }
      logger.error({ err }, "google login failed");
      reply.redirect(`${env.WEB_ORIGIN}/login?error=google_failed`);
    }
  });

  // Lets an already-signed-in user (e.g. via Google) set an email + password on their
  // same account, so they can also log in without Google.
  app.post("/api/auth/set-password", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = setPasswordSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();

    const [conflict] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, userId)));
    if (conflict) {
      reply.status(409).send({ error: { message: "That email is already in use", code: "EMAIL_TAKEN" } });
      return;
    }

    const [updated] = await db
      .update(users)
      .set({ email, passwordHash: hashPassword(body.password) })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    return { id: updated.id, email: updated.email };
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
    return { id: user.id, email: user.email, timezone: user.timezone };
  });
}
