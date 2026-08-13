import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { updateUserSettingsSchema } from "@run-far/shared";
import { requireUserId } from "../lib/session.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { env } from "../env.js";

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [user] = await db
      .select({
        assistantModel: users.assistantModel,
        planModel: users.planModel,
        locationLat: users.locationLat,
        locationLon: users.locationLon,
        locationUpdatedAt: users.locationUpdatedAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    return {
      assistantModel: user.assistantModel,
      planModel: user.planModel,
      defaultAssistantModel: env.ANTHROPIC_MODEL,
      defaultPlanModel: env.ANTHROPIC_MODEL,
      locationLat: user.locationLat,
      locationLon: user.locationLon,
      locationUpdatedAt: user.locationUpdatedAt?.toISOString() ?? null,
    };
  });

  app.patch("/api/settings", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = updateUserSettingsSchema.parse(request.body);
    const settingLocation = "locationLat" in body || "locationLon" in body;
    const [updated] = await db
      .update(users)
      .set({
        ...("assistantModel" in body ? { assistantModel: body.assistantModel ?? null } : {}),
        ...("planModel" in body ? { planModel: body.planModel ?? null } : {}),
        ...("locationLat" in body ? { locationLat: body.locationLat ?? null } : {}),
        ...("locationLon" in body ? { locationLon: body.locationLon ?? null } : {}),
        ...(settingLocation ? { locationUpdatedAt: body.locationLat != null ? new Date() : null } : {}),
      })
      .where(eq(users.id, userId))
      .returning({
        assistantModel: users.assistantModel,
        planModel: users.planModel,
        locationLat: users.locationLat,
        locationLon: users.locationLon,
        locationUpdatedAt: users.locationUpdatedAt,
      });
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    return {
      assistantModel: updated.assistantModel,
      planModel: updated.planModel,
      defaultAssistantModel: env.ANTHROPIC_MODEL,
      defaultPlanModel: env.ANTHROPIC_MODEL,
      locationLat: updated.locationLat,
      locationLon: updated.locationLon,
      locationUpdatedAt: updated.locationUpdatedAt?.toISOString() ?? null,
    };
  });
}
