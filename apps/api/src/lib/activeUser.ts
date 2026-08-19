import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { SESSION_COOKIE } from "./session.js";
import { cookieOpts } from "./cookies.js";

// Routes a signed-in-but-pending user still needs: checking their own status, signing out,
// and finishing/retrying email verification. Everything else is closed until approvedAt is set.
const PENDING_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/verify-email",
  "/api/auth/resend-verification",
]);

/**
 * Kills a live session the moment its account is disabled from the backoffice, rather than
 * letting the (30-day) session cookie ride until it expires. Also blocks all but a small
 * allowlist of routes while the account is awaiting admin approval (approvedAt is null).
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
    .select({ disabledAt: users.disabledAt, approvedAt: users.approvedAt })
    .from(users)
    .where(eq(users.id, unsigned.value));

  if (user?.disabledAt) {
    reply.clearCookie(SESSION_COOKIE, cookieOpts());
    await reply.status(401).send({
      error: { message: "Account disabled", code: "ACCOUNT_DISABLED" },
    });
    return;
  }

  if (user && !user.approvedAt && !PENDING_ALLOWED_PATHS.has(url)) {
    await reply.status(403).send({
      error: { message: "Account pending approval", code: "PENDING_APPROVAL" },
    });
  }
}
