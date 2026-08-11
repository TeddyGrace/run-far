import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../lib/auth.js";
import { setSessionCookie, clearSessionCookie, requireUserId } from "../lib/session.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      reply.status(401).send({ error: { message: "Invalid credentials", code: "INVALID_LOGIN" } });
      return;
    }
    setSessionCookie(reply, user.id);
    return { id: user.id, email: user.email };
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
