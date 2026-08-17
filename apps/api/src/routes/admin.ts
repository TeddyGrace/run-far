import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { invitedEmails, accessRequests, users } from "../db/schema.js";
import { requireAdminUserId } from "../lib/adminAuth.js";

const addInviteSchema = z.object({
  email: z.string().email(),
  note: z.string().trim().max(500).optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/me", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return { isAdmin: true };
  });

  app.get("/api/admin/invites", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return db.select().from(invitedEmails).orderBy(desc(invitedEmails.invitedAt));
  });

  app.post("/api/admin/invites", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const body = addInviteSchema.parse(request.body);
    const email = body.email.trim().toLowerCase();

    const [invite] = await db
      .insert(invitedEmails)
      .values({ email, note: body.note, invitedBy: userId })
      .onConflictDoUpdate({
        target: invitedEmails.email,
        set: { note: body.note, invitedBy: userId },
      })
      .returning();

    // Someone who already tried and was denied should drop off the access-requests list
    // once they're invited.
    await db
      .update(accessRequests)
      .set({ status: "invited" })
      .where(eq(accessRequests.email, email));

    reply.status(201).send(invite);
  });

  app.delete("/api/admin/invites/:id", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    await db.delete(invitedEmails).where(eq(invitedEmails.id, id));
    reply.status(204).send();
  });

  app.get("/api/admin/access-requests", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return db.select().from(accessRequests).orderBy(desc(accessRequests.lastRequestedAt));
  });

  app.post("/api/admin/access-requests/:id/approve", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [requested] = await db.select().from(accessRequests).where(eq(accessRequests.id, id));
    if (!requested) {
      reply.status(404).send({ error: { message: "Access request not found", code: "NOT_FOUND" } });
      return;
    }

    await db
      .insert(invitedEmails)
      .values({ email: requested.email, invitedBy: userId })
      .onConflictDoUpdate({
        target: invitedEmails.email,
        set: { invitedBy: userId },
      });
    const [updated] = await db
      .update(accessRequests)
      .set({ status: "invited" })
      .where(eq(accessRequests.id, id))
      .returning();
    return updated;
  });

  // --- Accounts ---
  //
  // The invite list only gates account CREATION, so removing an invite does nothing to an
  // account that already exists — revoking a real account happens here instead. Disabling is
  // reversible and keeps their data; deleting is not, and cascades to everything they own.

  app.get("/api/admin/users", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;
    return db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
  });

  app.post("/api/admin/users/:id/disable", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (id === userId) {
      reply.status(400).send({
        error: { message: "You can't disable your own account", code: "SELF_TARGET" },
      });
      return;
    }

    const [updated] = await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, disabledAt: users.disabledAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  app.post("/api/admin/users/:id/enable", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [updated] = await db
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, disabledAt: users.disabledAt });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    if (id === userId) {
      reply.status(400).send({
        error: { message: "You can't delete your own account", code: "SELF_TARGET" },
      });
      return;
    }

    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, id));
    if (!target) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    // Drop the invite too, otherwise the same email can immediately sign up again and the
    // delete reads as a no-op.
    await db.delete(invitedEmails).where(eq(invitedEmails.email, target.email));
    await db.delete(users).where(eq(users.id, id));
    reply.status(204).send();
  });

  app.delete("/api/admin/access-requests/:id", async (request, reply) => {
    const userId = await requireAdminUserId(request, reply);
    if (!userId) return;

    const { id } = idParamSchema.parse(request.params);
    const [updated] = await db
      .update(accessRequests)
      .set({ status: "dismissed" })
      .where(eq(accessRequests.id, id))
      .returning();
    if (!updated) {
      reply.status(404).send({ error: { message: "Access request not found", code: "NOT_FOUND" } });
      return;
    }
    return updated;
  });
}
