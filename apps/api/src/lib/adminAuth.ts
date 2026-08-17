import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { requireUserId } from "./session.js";

/**
 * Requires a valid session AND role === "admin" on the DB row — role is set only by data
 * migration (see drizzle/0018_handy_maddog.sql), never by any app route, so this can't be
 * self-granted. Sends 401/403 and returns undefined on failure — callers should
 * `if (!userId) return;` immediately after calling this, same as requireUserId.
 */
export async function requireAdminUserId(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | undefined> {
  const userId = requireUserId(request, reply);
  if (!userId) return undefined;

  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!user || user.role !== "admin") {
    reply.status(403).send({ error: { message: "Forbidden", code: "FORBIDDEN" } });
    return undefined;
  }
  return userId;
}
