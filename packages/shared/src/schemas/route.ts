import { z } from "zod";

// Routes are stored and passed around as [lat, lon] pairs — the order Leaflet uses, so the web
// client can hand them to the map without reshuffling. (OSRM/GeoJSON use [lon, lat]; that
// conversion lives in the API's routing client and nowhere else.)
export const latLonSchema = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
export type LatLon = z.infer<typeof latLonSchema>;

export const routeSourceSchema = z.enum(["manual", "ai"]);
export type RouteSource = z.infer<typeof routeSourceSchema>;

/** A route the routing engine has snapped to real paths. */
export const plannedRouteSchema = z.object({
  waypoints: z.array(latLonSchema).min(2).max(50),
  geometry: z.array(latLonSchema).min(2),
  distanceM: z.number().nonnegative(),
  /** Total climb/descent along the route. Null when elevation isn't configured or the
   * elevation service couldn't answer — "unknown", never "flat". */
  elevationGainM: z.number().nonnegative().nullable().default(null),
  elevationLossM: z.number().nonnegative().nullable().default(null),
});
export type PlannedRoute = z.infer<typeof plannedRouteSchema>;

export const snapRouteInputSchema = z.object({
  waypoints: z.array(latLonSchema).min(2).max(50),
  /** The web client snaps one segment at a time and asks for elevation once for the whole
   * route (POST /routes/elevation), so it turns this off per segment. */
  elevation: z.boolean().default(true),
});

export const routeElevationInputSchema = z.object({
  geometry: z.array(latLonSchema).min(2).max(5_000),
});
export const routeElevationSchema = z.object({
  elevationGainM: z.number().nullable(),
  elevationLossM: z.number().nullable(),
});
export type RouteElevation = z.infer<typeof routeElevationSchema>;
export type SnapRouteInput = z.infer<typeof snapRouteInputSchema>;

export const generateRouteInputSchema = z.object({
  start: latLonSchema,
  prompt: z.string().trim().min(1).max(1_000),
});
export type GenerateRouteInput = z.infer<typeof generateRouteInputSchema>;

export const generatedRouteSchema = plannedRouteSchema.extend({
  name: z.string(),
  summary: z.string(),
});
export type GeneratedRoute = z.infer<typeof generatedRouteSchema>;

/** Map settings the web client needs, served by the API so the tile provider is server config. */
export const routeMapConfigSchema = z.object({
  tileUrl: z.string(),
  tileAttribution: z.string(),
  elevationEnabled: z.boolean(),
});
export type RouteMapConfig = z.infer<typeof routeMapConfigSchema>;

export const generateRouteResultSchema = z.object({
  /** The assistant's explanation, or its question back when it couldn't build a route. */
  message: z.string(),
  route: generatedRouteSchema.nullable(),
});
export type GenerateRouteResult = z.infer<typeof generateRouteResultSchema>;

export const saveRouteInputSchema = plannedRouteSchema.extend({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(2_000).nullable().optional(),
  source: routeSourceSchema,
});
export type SaveRouteInput = z.infer<typeof saveRouteInputSchema>;

export const savedRouteSchema = saveRouteInputSchema.extend({
  id: z.string().uuid(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type SavedRoute = z.infer<typeof savedRouteSchema>;

/** Server-sent frames from POST /api/routes/generate/stream. */
export const routePlanStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), message: z.string() }),
  z.object({ type: z.literal("done"), result: generateRouteResultSchema }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string() }),
]);
export type RoutePlanStreamEvent = z.infer<typeof routePlanStreamEventSchema>;
