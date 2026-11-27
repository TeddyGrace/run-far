import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  generateRouteInputSchema,
  saveRouteInputSchema,
  snapRouteInputSchema,
  type LatLon,
  type SavedRoute,
} from "@run-far/shared";
import { rateLimitKey, requireUserId } from "../lib/session.js";
import { db } from "../db/client.js";
import { savedRoutes } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { assertWithinAiQuota, AiQuotaExceededError, aiRouteRateLimit } from "../lib/aiCost.js";
import { RoutingError, routeThrough } from "../integrations/routing/routingClient.js";
import { isAnthropicConfigured, planRouteWithAi } from "../integrations/anthropic/routePlanner.js";

const MAX_SAVED_ROUTES_PER_USER = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSavedRoute(row: typeof savedRoutes.$inferSelect): SavedRoute {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    source: row.source,
    distanceM: row.distanceM,
    waypoints: row.waypoints as LatLon[],
    geometry: row.geometry as LatLon[],
    createdAt: row.createdAt.toISOString(),
  };
}

function sendRoutingError(reply: FastifyReply, err: RoutingError) {
  // NO_ROUTE is the athlete's points, not our outage — 422 so the UI shows it as a hint.
  reply.status(err.code === "NO_ROUTE" ? 422 : 502).send({ error: { message: err.message, code: `ROUTING_${err.code}` } });
}

export async function routePlannerRoutes(app: FastifyInstance) {
  // Proxied rather than called from the browser so the routing host is server config (swap to a
  // self-hosted OSRM without shipping a client), and so it sits behind auth and rate limiting
  // instead of letting any page visitor spend a fair-use public service's goodwill.
  app.post(
    "/api/routes/snap",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: rateLimitKey } } },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (!userId) return;
      const body = snapRouteInputSchema.parse(request.body);
      try {
        return await routeThrough(body.waypoints);
      } catch (err) {
        if (err instanceof RoutingError) return sendRoutingError(reply, err);
        throw err;
      }
    },
  );

  app.post("/api/routes/generate", { config: { rateLimit: aiRouteRateLimit } }, async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    if (!isAnthropicConfigured()) {
      reply.status(503).send({
        error: { message: "Anthropic is not configured. Set ANTHROPIC_API_KEY in .env.", code: "AI_NOT_CONFIGURED" },
      });
      return;
    }
    try {
      await assertWithinAiQuota(userId);
    } catch (err) {
      if (err instanceof AiQuotaExceededError) {
        reply.status(429).send({
          error: { message: "Monthly AI usage limit reached — check back next month.", code: "AI_QUOTA_EXCEEDED" },
        });
        return;
      }
      throw err;
    }

    const body = generateRouteInputSchema.parse(request.body);
    try {
      return await planRouteWithAi({ userId, start: body.start, prompt: body.prompt });
    } catch (err) {
      logger.error({ err, userId }, "AI route planning failed");
      reply.status(502).send({ error: { message: "Couldn't plan a route right now. Try again shortly.", code: "AI_ROUTE_FAILED" } });
    }
  });

  app.get("/api/routes", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const rows = await db
      .select()
      .from(savedRoutes)
      .where(eq(savedRoutes.userId, userId))
      .orderBy(desc(savedRoutes.createdAt));
    return { items: rows.map(toSavedRoute) };
  });

  app.post("/api/routes", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const body = saveRouteInputSchema.parse(request.body);

    const existing = await db.$count(savedRoutes, eq(savedRoutes.userId, userId));
    if (existing >= MAX_SAVED_ROUTES_PER_USER) {
      reply.status(409).send({
        error: { message: `You can save up to ${MAX_SAVED_ROUTES_PER_USER} routes. Delete one to save another.`, code: "ROUTE_LIMIT" },
      });
      return;
    }

    const [row] = await db
      .insert(savedRoutes)
      .values({
        userId,
        name: body.name,
        notes: body.notes ?? null,
        source: body.source,
        distanceM: body.distanceM,
        waypoints: body.waypoints,
        geometry: body.geometry,
      })
      .returning();
    if (!row) throw new Error("failed to save route");
    reply.status(201);
    return toSavedRoute(row);
  });

  app.delete("/api/routes/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      reply.status(404).send({ error: { message: "Route not found", code: "NOT_FOUND" } });
      return;
    }
    const deleted = await db
      .delete(savedRoutes)
      .where(and(eq(savedRoutes.id, id), eq(savedRoutes.userId, userId)))
      .returning({ id: savedRoutes.id });
    if (deleted.length === 0) {
      reply.status(404).send({ error: { message: "Route not found", code: "NOT_FOUND" } });
      return;
    }
    return { ok: true };
  });
}
