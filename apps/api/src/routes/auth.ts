import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  setPasswordSchema,
  signupSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@run-far/shared";
import { db } from "../db/client.js";
import { users, invitedEmails, accessRequests } from "../db/schema.js";
import { hashPassword, verifyPassword, verifyAgainstDummyHash, isLegacyHash } from "../lib/auth.js";
import { normalizeEmail } from "../lib/email.js";
import { issueAuthToken, consumeAuthToken } from "../lib/authTokens.js";
import { sendSystemMail } from "../lib/systemMail.js";
import {
  verificationEmail,
  alreadyHasAccountEmail,
  passwordResetEmail,
} from "../lib/emailTemplates.js";
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

/** Thrown when an existing account has been disabled from the backoffice. Existing users
 * only — the allowlist gates account creation, not sign-in of an already-created account. */
class AccountDisabledError extends Error {
  constructor(readonly email: string) {
    super(`account disabled: ${email}`);
  }
}

async function isEmailAllowedToSignUp(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const [invited] = await db
    .select({ id: invitedEmails.id })
    .from(invitedEmails)
    .where(eq(invitedEmails.email, normalized));
  if (invited) return true;

  // Back-compat: the ALLOWED_EMAILS env var still works alongside the DB-backed allowlist.
  if (env.allowedEmails.size > 0) return env.allowedEmails.has(normalized);
  // No allowlist configured: fail closed in production, open in dev so a fresh checkout
  // still works without env setup.
  return env.NODE_ENV !== "production";
}

/** Logs a signup/sign-in from an email not on the allowlist, so the backoffice can surface
 * it as a pending signup to approve or deny — used for both Google and password accounts
 * now that account creation itself is no longer gated by the allowlist. */
async function recordAccessRequest(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  await db
    .insert(accessRequests)
    .values({ email: normalized })
    .onConflictDoUpdate({
      target: accessRequests.email,
      set: {
        lastRequestedAt: new Date(),
        requestCount: sql`${accessRequests.requestCount} + 1`,
      },
    });
}

async function findOrCreateGoogleUser(identity: {
  sub: string;
  email: string;
}): Promise<typeof users.$inferSelect> {
  const email = normalizeEmail(identity.email);

  const [bySub] = await db.select().from(users).where(eq(users.googleSub, identity.sub));
  if (bySub) {
    if (bySub.disabledAt) throw new AccountDisabledError(bySub.email);
    return bySub;
  }

  const [byEmail] = await db.select().from(users).where(eq(users.email, email));
  if (byEmail) {
    if (byEmail.disabledAt) throw new AccountDisabledError(byEmail.email);
    // Merge: link this Google identity onto the existing account (created via password
    // signup, or an earlier Google sign-in that predates google_sub matching for some
    // reason) so it's the same row, same data, either way round.
    const [linked] = await db
      .update(users)
      .set({
        googleSub: identity.sub,
        emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
      })
      .where(eq(users.id, byEmail.id))
      .returning();
    if (!linked) throw new Error("failed to link google sub to existing user");
    return linked;
  }

  const allowed = await isEmailAllowedToSignUp(email);
  if (!allowed) await recordAccessRequest(email);

  const [created] = await db
    .insert(users)
    .values({
      email,
      googleSub: identity.sub,
      passwordHash: null,
      emailVerifiedAt: new Date(), // Google already asserts email_verified on the ID token
      approvedAt: allowed ? new Date() : null,
      signupSource: "google",
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
  app.post(
    "/api/auth/signup",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => {
      const body = signupSchema.parse(request.body);
      const email = normalizeEmail(body.email);

      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing) {
        // Same generic response whether or not the account exists, so a caller can't use
        // this endpoint to enumerate accounts — but tell the real owner what happened.
        await sendSystemMail({ to: email, ...alreadyHasAccountEmail() });
        return { ok: true };
      }

      const [created] = await db
        .insert(users)
        .values({
          email,
          passwordHash: await hashPassword(body.password),
          emailVerifiedAt: null,
          approvedAt: null,
          signupSource: "password",
        })
        .returning();
      if (!created) throw new Error("failed to create user");

      const token = await issueAuthToken(created.id, "email_verification");
      await sendSystemMail({ to: email, ...verificationEmail(token) });

      return { ok: true };
    },
  );

  app.post("/api/auth/verify-email", async (request, reply) => {
    const body = verifyEmailSchema.parse(request.body);
    const userId = await consumeAuthToken(body.token, "email_verification");
    if (!userId) {
      reply.status(400).send({ error: { message: "Invalid or expired link", code: "INVALID_TOKEN" } });
      return;
    }

    const [user] = await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!user) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    if (user.disabledAt) {
      reply.status(403).send({ error: { message: "Account disabled", code: "ACCOUNT_DISABLED" } });
      return;
    }

    if (!user.approvedAt) await recordAccessRequest(user.email);

    setSessionCookie(reply, user.id);
    return { id: user.id, email: user.email };
  });

  app.post(
    "/api/auth/resend-verification",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request) => {
      const body = resendVerificationSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));

      if (user && !user.emailVerifiedAt && !user.disabledAt) {
        const token = await issueAuthToken(user.id, "email_verification");
        await sendSystemMail({ to: email, ...verificationEmail(token) });
      }
      // Generic response regardless of whether the account exists or is already verified.
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => {
      const body = forgotPasswordSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));

      if (user && !user.disabledAt) {
        const token = await issueAuthToken(user.id, "password_reset");
        await sendSystemMail({ to: email, ...passwordResetEmail(token) });
      }
      // Generic response whether or not the account exists, to avoid enumeration.
      return { ok: true };
    },
  );

  app.post("/api/auth/reset-password", async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);
    const userId = await consumeAuthToken(body.token, "password_reset");
    if (!userId) {
      reply.status(400).send({ error: { message: "Invalid or expired link", code: "INVALID_TOKEN" } });
      return;
    }

    const [existing] = await db.select().from(users).where(eq(users.id, userId));
    if (!existing) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    if (existing.disabledAt) {
      reply.status(403).send({ error: { message: "Account disabled", code: "ACCOUNT_DISABLED" } });
      return;
    }

    const [updated] = await db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.password),
        // A working emailed link is proof of ownership, same as clicking the verification link.
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    setSessionCookie(reply, updated.id);
    return { id: updated.id, email: updated.email };
  });

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));

      if (!user?.passwordHash) {
        await verifyAgainstDummyHash(body.password);
        reply.status(401).send({ error: { message: "Invalid credentials", code: "INVALID_LOGIN" } });
        return;
      }
      if (!(await verifyPassword(body.password, user.passwordHash))) {
        reply.status(401).send({ error: { message: "Invalid credentials", code: "INVALID_LOGIN" } });
        return;
      }
      // A successful verify against an old scrypt hash is the only chance to upgrade it —
      // transparent to the user, no forced reset.
      if (isLegacyHash(user.passwordHash)) {
        await db
          .update(users)
          .set({ passwordHash: await hashPassword(body.password) })
          .where(eq(users.id, user.id));
      }
      if (user.disabledAt) {
        reply.status(403).send({ error: { message: "Account disabled", code: "ACCOUNT_DISABLED" } });
        return;
      }
      if (!user.emailVerifiedAt) {
        reply
          .status(403)
          .send({ error: { message: "Please verify your email first", code: "EMAIL_UNVERIFIED" } });
        return;
      }

      setSessionCookie(reply, user.id);
      return { id: user.id, email: user.email, timezone: user.timezone };
    },
  );

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
    reply.clearCookie(OAUTH_STATE_COOKIE, cookieOpts());
    reply.clearCookie(CONSENT_RETRY_COOKIE, cookieOpts());

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

      if (!user.approvedAt) {
        // Don't hold Google refresh tokens or spin up a calendar for an account nobody's
        // approved yet — the pending screen offers to reconnect Google once they are.
        reply.redirect(`${env.WEB_ORIGIN}/`);
        return;
      }

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
      if (err instanceof AccountDisabledError) {
        reply.redirect(`${env.WEB_ORIGIN}/login?error=account_disabled`);
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
    const email = normalizeEmail(body.email);

    const [current] = await db.select().from(users).where(eq(users.id, userId));
    if (!current) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    // If a password is already set, require it to change it — otherwise a stolen/borrowed
    // session cookie could silently take over sign-in credentials.
    if (current.passwordHash) {
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, current.passwordHash))) {
        reply
          .status(401)
          .send({ error: { message: "Current password is incorrect", code: "INVALID_PASSWORD" } });
        return;
      }
    }

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
      .set({ email, passwordHash: await hashPassword(body.password) })
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
    return {
      id: user.id,
      email: user.email,
      timezone: user.timezone,
      needsTutorial: user.tutorialCompletedAt == null,
      approved: user.approvedAt != null,
      emailVerified: user.emailVerifiedAt != null,
      hasPassword: user.passwordHash != null,
    };
  });
}
