import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  generateRouteInputSchema,
  routeElevationInputSchema,
  saveRouteInputSchema,
  snapRouteInputSchema,
  type LatLon,
  type RouteElevation,
  type RouteMapConfig,
  type RoutePlanStreamEvent,
  type SavedRoute,
} from "@run-far/shared";
import { rateLimitKey, requireUserId } from "../lib/session.js";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { elevationFor, isElevationEnabled } from "../integrations/routing/elevation.js";
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
    elevationGainM: row.elevationGainM,
    elevationLossM: row.elevationLossM,
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
        return await routeThrough(body.waypoints, fetch, { withElevation: body.elevation });
      } catch (err) {
        if (err instanceof RoutingError) return sendRoutingError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/api/routes/elevation",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: rateLimitKey } } },
    async (request, reply): Promise<RouteElevation | undefined> => {
      const userId = requireUserId(request, reply);
      if (!userId) return;
      const body = routeElevationInputSchema.parse(request.body);
      const elevation = await elevationFor(body.geometry);
      return { elevationGainM: elevation?.gainM ?? null, elevationLossM: elevation?.lossM ?? null };
    },
  );

  app.get("/api/routes/config", async (request, reply): Promise<RouteMapConfig | undefined> => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    return {
      tileUrl: env.MAP_TILE_URL,
      tileAttribution: env.MAP_TILE_ATTRIBUTION,
      elevationEnabled: isElevationEnabled(),
    };
  });

  // Streams progress while the planner works: a request is several model round trips plus
  // place search and routing, and can take tens of seconds. Each frame is one JSON object
  // matching routePlanStreamEventSchema in @run-far/shared.
  app.post("/api/routes/generate/stream", { config: { rateLimit: aiRouteRateLimit } }, async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    if (!isAnthropicConfigured()) {
      reply.status(503).send({
        error: { message: "Anthropic is not configured. Set ANTHROPIC_API_KEY in .env.", code: "AI_NOT_CONFIGURED" },
      });
      return;
    }
    // Checked before hijacking the socket so these stay ordinary JSON errors.
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

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: RoutePlanStreamEvent) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Keeps proxies with idle timeouts from cutting the connection during a long model call.
    const heartbeat = setInterval(() => raw.write(": keep-alive\n\n"), 15_000);

    try {
      const result = await planRouteWithAi(
        { userId, start: body.start, prompt: body.prompt },
        { onProgress: (message) => send({ type: "progress", message }) },
      );
      send({ type: "done", result });
    } catch (err) {
      logger.error({ err, userId }, "AI route planning failed");
      send({ type: "error", message: "Couldn't plan a route right now. Try again shortly.", code: "AI_ROUTE_FAILED" });
    } finally {
      clearInterval(heartbeat);
      raw.end();
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
        elevationGainM: body.elevationGainM,
        elevationLossM: body.elevationLossM,
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
