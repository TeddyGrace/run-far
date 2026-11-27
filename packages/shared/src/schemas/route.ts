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
});
export type PlannedRoute = z.infer<typeof plannedRouteSchema>;

export const snapRouteInputSchema = z.object({
  waypoints: z.array(latLonSchema).min(2).max(50),
});
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
