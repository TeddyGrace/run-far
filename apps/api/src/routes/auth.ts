import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
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
import { users, invitedEmails } from "../db/schema.js";
import { hashPassword, verifyPassword, verifyAgainstDummyHash, isLegacyHash } from "../lib/auth.js";
import { normalizeEmail } from "../lib/email.js";
import { issueAuthToken, consumeAuthToken } from "../lib/authTokens.js";
import { sendSystemMail, MailTransportDownError } from "../lib/systemMail.js";
import {
  verificationEmail,
  alreadyHasAccountEmail,
  passwordResetEmail,
} from "../lib/emailTemplates.js";
import { setSessionCookie, clearSessionCookie, requireUserId } from "../lib/session.js";
import { resolveEntitlement } from "../lib/entitlement.js";
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

/** Whether `email` should be auto-comped (full free access) the moment it signs up — the
 * DB-backed invite allowlist, or the ALLOWED_EMAILS env var. Signup itself is never gated
 * (see routes/auth.ts signup/findOrCreateGoogleUser below): everyone can create an account,
 * they just land on the paywall (lib/entitlement.ts) until they subscribe or are comped —
 * this only decides who skips that paywall on day one. */
async function shouldAutoComp(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const [invited] = await db
    .select({ id: invitedEmails.id })
    .from(invitedEmails)
    .where(eq(invitedEmails.email, normalized));
  if (invited) return true;

  if (env.allowedEmails.size > 0) return env.allowedEmails.has(normalized);
  // No allowlist configured: auto-comp in dev so a fresh checkout can exercise paid features
  // without env setup; in production this just means nobody gets a free ride by default.
  return env.NODE_ENV !== "production";
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

  const autoComp = await shouldAutoComp(email);

  const [created] = await db
    .insert(users)
    .values({
      email,
      googleSub: identity.sub,
      passwordHash: null,
      emailVerifiedAt: new Date(), // Google already asserts email_verified on the ID token
      // approvedAt no longer gates anything (see lib/entitlement.ts) — every new account gets
      // it set, kept only for the deprecated `approved` field on /api/auth/me.
      approvedAt: new Date(),
      ...(autoComp
        ? { entitlementSource: "comp" as const, entitlementStatus: "active" as const, compedAt: new Date() }
        : {}),
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
        // this endpoint to enumerate accounts — but tell the real owner what happened. A dead
        // mail transport shouldn't turn "you already have an account" into a 500, so it's
        // logged and swallowed rather than surfaced.
        try {
          await sendSystemMail({ to: email, ...alreadyHasAccountEmail() });
        } catch (err) {
          if (!(err instanceof MailTransportDownError)) throw err;
          logger.error({ err, email }, "could not send already-has-account email: mail transport down");
        }
        return { ok: true };
      }

      // Invited (allowlisted) emails are auto-comped on signup regardless of method, matching
      // the Google path in findOrCreateGoogleUser — an admin invite shouldn't need a second
      // manual step just because the person chose a password.
      const autoComp = await shouldAutoComp(email);

      const [created] = await db
        .insert(users)
        .values({
          email,
          passwordHash: await hashPassword(body.password),
          emailVerifiedAt: null,
          // approvedAt no longer gates anything (see lib/entitlement.ts) — every new account
          // gets it set, kept only for the deprecated `approved` field on /api/auth/me.
          approvedAt: new Date(),
          ...(autoComp
            ? { entitlementSource: "comp" as const, entitlementStatus: "active" as const, compedAt: new Date() }
            : {}),
          signupSource: "password",
        })
        .returning();
      if (!created) throw new Error("failed to create user");

      const token = await issueAuthToken(created.id, "email_verification");
      let mailSent = true;
      try {
        await sendSystemMail({ to: email, ...verificationEmail(token) });
      } catch (err) {
        if (!(err instanceof MailTransportDownError)) throw err;
        mailSent = false;
        logger.error(
          { err, userId: created.id },
          "account created but verification email could not be sent: mail transport down",
        );
      }

      return { ok: true, mailSent };
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
        try {
          await sendSystemMail({ to: email, ...verificationEmail(token) });
        } catch (err) {
          if (!(err instanceof MailTransportDownError)) throw err;
          logger.error({ err, userId: user.id }, "could not resend verification email: mail transport down");
        }
      }
      // Generic response regardless of whether the account exists, is already verified, or
      // mail couldn't be sent — this endpoint can't be used to probe any of those.
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
        try {
          await sendSystemMail({ to: email, ...passwordResetEmail(token) });
        } catch (err) {
          if (!(err instanceof MailTransportDownError)) throw err;
          logger.error({ err, userId: user.id }, "could not send password reset email: mail transport down");
        }
      }
      // Generic response whether or not the account exists or mail could be sent, to avoid
      // enumeration.
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

      if (!resolveEntitlement(user).active) {
        // Don't hold Google refresh tokens or spin up a calendar for an account with no
        // active entitlement — the paywall offers to reconnect Google once they subscribe.
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
      role: user.role,
      needsTutorial: user.tutorialCompletedAt == null,
      // Deprecated in favor of `entitlement.active` — kept for one release so the web client
      // can be updated independently of this route shipping.
      approved: user.approvedAt != null,
      entitlement: resolveEntitlement(user),
      emailVerified: user.emailVerifiedAt != null,
      hasPassword: user.passwordHash != null,
    };
  });
}
