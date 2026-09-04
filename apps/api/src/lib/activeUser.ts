import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { SESSION_COOKIE } from "./session.js";
import { cookieOpts } from "./cookies.js";
import { resolveEntitlement } from "./entitlement.js";

// Routes a signed-in-but-unentitled user still needs: checking their own status, signing out,
// finishing/retrying email verification, subscribing or managing billing, and closing their own
// account. Everything else is closed until resolveEntitlement(user).active is true.
const UNENTITLED_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/verify-email",
  "/api/auth/resend-verification",
  "/api/account/export",
  "/api/account",
]);
// Prefix rather than exact match — /api/billing covers checkout, portal, status, and the
// webhook-adjacent routes that may be added under it later, without editing this list again.
const UNENTITLED_ALLOWED_PREFIXES = ["/api/billing"];

function isUnentitledAllowed(url: string): boolean {
  if (UNENTITLED_ALLOWED_PATHS.has(url)) return true;
  return UNENTITLED_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix));
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
  // Let a disabled user still clear their own cookie.
  if (url === "/api/auth/logout") return;

  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return; // requireUserId reports the bad session

  const [user] = await db
    .select({
      disabledAt: users.disabledAt,
      role: users.role,
      entitlementSource: users.entitlementSource,
      entitlementStatus: users.entitlementStatus,
      entitlementExpiresAt: users.entitlementExpiresAt,
    })
    .from(users)
    .where(eq(users.id, unsigned.value));

  if (user?.disabledAt) {
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
