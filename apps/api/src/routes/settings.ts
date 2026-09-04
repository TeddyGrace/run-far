import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { updateUserSettingsSchema } from "@run-far/shared";
import { requireUserId } from "../lib/session.js";
import { db } from "../db/client.js";
import { users, oauthConnections, trainingPlans } from "../db/schema.js";
import { env } from "../env.js";

function isValidIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [user] = await db
      .select({
        role: users.role,
        assistantModel: users.assistantModel,
        planModel: users.planModel,
        locationLat: users.locationLat,
        locationLon: users.locationLon,
        locationUpdatedAt: users.locationUpdatedAt,
        timezone: users.timezone,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    return {
      // A non-admin's stored override, if one predates the admin-only restriction below, is
      // never surfaced or honored (see integrations/anthropic/{assistantChat,planChat}.ts).
      assistantModel: user.role === "admin" ? user.assistantModel : null,
      planModel: user.role === "admin" ? user.planModel : null,
      defaultAssistantModel: env.ANTHROPIC_MODEL,
      defaultPlanModel: env.ANTHROPIC_MODEL,
      canChooseModel: user.role === "admin",
      locationLat: user.locationLat,
      locationLon: user.locationLon,
      locationUpdatedAt: user.locationUpdatedAt?.toISOString() ?? null,
      timezone: user.timezone,
    };
  });

  app.patch("/api/settings", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = updateUserSettingsSchema.parse(request.body);
    if (body.timezone != null && !isValidIanaTimeZone(body.timezone)) {
      reply.status(400).send({ error: { message: "Invalid timezone", code: "INVALID_TIMEZONE" } });
      return;
    }

    const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    const isAdmin = actor?.role === "admin";
    // Model choice drives which Anthropic model gets billed per request (see
    // integrations/anthropic/{assistantChat,planChat}.ts) — restricting who can set it is a
    // cost control, not a preference, so a non-admin's assistantModel/planModel fields (if
    // sent at all) are silently dropped rather than 403ing the whole request.
    if (!isAdmin && ("assistantModel" in body || "planModel" in body)) {
      delete body.assistantModel;
      delete body.planModel;
    }

    const settingLocation = "locationLat" in body || "locationLon" in body;
    const returning = {
      assistantModel: users.assistantModel,
      planModel: users.planModel,
      locationLat: users.locationLat,
      locationLon: users.locationLon,
      locationUpdatedAt: users.locationUpdatedAt,
      timezone: users.timezone,
    };
    const fields = {
      ...(isAdmin && "assistantModel" in body ? { assistantModel: body.assistantModel ?? null } : {}),
      ...(isAdmin && "planModel" in body ? { planModel: body.planModel ?? null } : {}),
      ...("locationLat" in body ? { locationLat: body.locationLat ?? null } : {}),
      ...("locationLon" in body ? { locationLon: body.locationLon ?? null } : {}),
      ...(settingLocation ? { locationUpdatedAt: body.locationLat != null ? new Date() : null } : {}),
      ...("timezone" in body ? { timezone: body.timezone ?? null } : {}),
    };
    // A non-admin sending only assistantModel/planModel leaves `fields` empty once those are
    // stripped above — .update().set({}) would otherwise throw, so that case is just a no-op
    // read of the current row instead of a write.
    const [updated] =
      Object.keys(fields).length > 0
        ? await db.update(users).set(fields).where(eq(users.id, userId)).returning(returning)
        : await db.select(returning).from(users).where(eq(users.id, userId));
    if (!updated) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    return {
      assistantModel: isAdmin ? updated.assistantModel : null,
      planModel: isAdmin ? updated.planModel : null,
      defaultAssistantModel: env.ANTHROPIC_MODEL,
      defaultPlanModel: env.ANTHROPIC_MODEL,
      canChooseModel: isAdmin,
      locationLat: updated.locationLat,
      locationLon: updated.locationLon,
      locationUpdatedAt: updated.locationUpdatedAt?.toISOString() ?? null,
      timezone: updated.timezone,
    };
  });

  // Drives the Dashboard's onboarding checklist — cheap enough (three small lookups by
  // primary/unique keys) to call on every dashboard load rather than caching.
  app.get("/api/settings/onboarding", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [[user], [whoopConn], [activePlan]] = await Promise.all([
      db
        .select({ locationLat: users.locationLat, locationLon: users.locationLon })
        .from(users)
        .where(eq(users.id, userId)),
      db
        .select({ id: oauthConnections.id })
        .from(oauthConnections)
        .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop"))),
      db
        .select({ id: trainingPlans.id })
        .from(trainingPlans)
        .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.status, "active"))),
    ]);

    return {
      hasWhoop: Boolean(whoopConn),
      hasLocation: user?.locationLat != null && user?.locationLon != null,
      hasPlan: Boolean(activePlan),
    };
  });

  // Marks the new-account tutorial overlay as done, whether finished or skipped — either way
  // it shouldn't reappear on later logins. Idempotent, safe to call more than once.
  app.post("/api/settings/tutorial-complete", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    await db.update(users).set({ tutorialCompletedAt: new Date() }).where(eq(users.id, userId));
    return { ok: true };
  });
}
