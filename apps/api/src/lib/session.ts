import type { FastifyReply, FastifyRequest } from "fastify";
import { cookieOpts } from "./cookies.js";

export const SESSION_COOKIE = "session";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

/** Sets the signed session cookie for a logged-in user. */
export function setSessionCookie(reply: FastifyReply, userId: string): void {
  reply.setCookie(
    SESSION_COOKIE,
    userId,
    cookieOpts({ signed: true, maxAge: SESSION_MAX_AGE_SEC }),
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Reads and verifies the session cookie. On failure, sends a 401 and returns undefined —
 * callers should `if (!userId) return;` immediately after calling this.
 */
export function requireUserId(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) {
    reply.status(401).send({ error: { message: "Not authenticated", code: "UNAUTHENTICATED" } });
    return undefined;
  }
  const result = request.unsignCookie(raw);
  if (!result.valid || !result.value) {
    reply.status(401).send({ error: { message: "Invalid session", code: "UNAUTHENTICATED" } });
    return undefined;
  }
  return result.value;
}
