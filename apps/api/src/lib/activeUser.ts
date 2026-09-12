import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { SESSION_COOKIE } from "./session.js";
import { cookieOpts } from "./cookies.js";
import { resolveEntitlement } from "./entitlement.js";
import { resolveDeviceToken } from "../integrations/appleHealth/devices.js";

// Routes a signed-in-but-unentitled user still needs: checking their own status, subscribing
// or managing billing, and exporting or closing their own account. Everything else is closed
// until resolveEntitlement(user).active is true. (Signing out and the email-verification
// routes live in PUBLIC_AUTH_PATHS below, which skips the guard entirely.)
const UNENTITLED_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/set-password",
  "/api/account/export",
  "/api/account",
]);
// Endpoints that establish (or recover) a session in the first place. These are
// unauthenticated by nature: whatever session cookie the browser happens to still be
// carrying is irrelevant to them, so the guard must not judge the request by it. Without
// this, a stale cookie from an unentitled account turns "sign in" and "create account"
// into 402 Subscription required — the request never reaches the route that would have
// replaced or rejected the cookie, so the user is locked out with a nonsensical error.
const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/logout",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/verify-email",
  "/api/auth/resend-verification",
  "/api/auth/google/start",
  "/api/auth/google/callback",
]);

// Prefix rather than exact match — /api/billing covers checkout, portal, status, and the
// webhook-adjacent routes that may be added under it later, without editing this list again.
const UNENTITLED_ALLOWED_PREFIXES = ["/api/billing"];

function isUnentitledAllowed(url: string): boolean {
  if (UNENTITLED_ALLOWED_PATHS.has(url)) return true;
  return UNENTITLED_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * The athlete a request is acting as, by either credential the app can present.
 *
 * The session cookie is the normal case. The bearer token is an Apple Health push from a
 * device's native background wake, which has no WebView and therefore no cookies (see
 * integrations/appleHealth/devices.ts).
 *
 * Resolving both *here*, in the global guard, rather than only in the ingest route is the
 * point: a device token is a long-lived credential with no expiry, so if the guard only
 * understood cookies, a disabled account's phone — or one whose subscription lapsed months ago
 * — would go on pushing data indefinitely, and the single place that decides what "active"
 * means would quietly not apply to the one credential that never ages out.
 */
async function requestUserId(request: FastifyRequest): Promise<string | null> {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw) {
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null; // requireUserId reports the bad session
    return unsigned.value;
  }

  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const resolved = await resolveDeviceToken(header.slice("Bearer ".length).trim());
    // An unknown or revoked token is the route's 401 to send, not the guard's: the guard only
    // has an opinion about accounts it can identify.
    return resolved?.userId ?? null;
  }

  return null;
}

/**
 * Kills a live session the moment its account is disabled from the backoffice, rather than
 * letting the (30-day) session cookie ride until it expires. Also blocks all but a small
 * allowlist of routes while the account has no active entitlement — see lib/entitlement.ts,
 * the single place that decides what "active" means (admin, comp, or a live Stripe/Apple
 * subscription).
 *
 * Implemented as one global hook instead of a check inside requireUserId so that every route
 * is covered by construction — a new route can't forget it. The DB lookup is skipped unless
 * the request is both `/api/*` and actually carrying a session cookie, so unauthenticated and
 * static-asset traffic pay nothing.
 *
 * Register as an `onRequest` hook, after @fastify/cookie (request.unsignCookie).
 */
export async function activeUserGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const url = request.url.split("?")[0] ?? "";
  if (!url.startsWith("/api")) return;
  // Sign-in/sign-up/recovery routes decide for themselves what the credentials in the body
  // mean; a leftover cookie must not pre-empt them. This also lets a disabled user clear
  // their own cookie via /api/auth/logout.
  if (PUBLIC_AUTH_PATHS.has(url)) return;

  const userId = await requestUserId(request);
  if (!userId) return; // no credentials, or a bad session the route itself will report

  const [user] = await db
    .select({
      disabledAt: users.disabledAt,
      role: users.role,
      entitlementSource: users.entitlementSource,
      entitlementStatus: users.entitlementStatus,
      entitlementExpiresAt: users.entitlementExpiresAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (user?.disabledAt) {
    // Harmless on a bearer-token request (there is no cookie to clear); the 401 is what stops
    // the device, and the app treats a 401 as "stop retrying, ask the athlete to reconnect".
    reply.clearCookie(SESSION_COOKIE, cookieOpts());
    await reply.status(401).send({
      error: { message: "Account disabled", code: "ACCOUNT_DISABLED" },
    });
    return;
  }

  if (user && !resolveEntitlement(user).active && !isUnentitledAllowed(url)) {
    await reply.status(402).send({
      error: { message: "Subscription required", code: "PAYMENT_REQUIRED" },
    });
  }
}
