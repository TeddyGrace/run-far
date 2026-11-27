import type { LatLon, PlannedRoute } from "@run-far/shared";
import { env } from "../../env.js";
import { elevationFor } from "./elevation.js";
import { bearingDeg, compassPoint, downsample, haversineM, initialLoopRadiusM, loopWaypoints, destinationPoint, DETOUR_FACTOR } from "./geo.js";

// Both services are public OpenStreetMap infrastructure whose usage policies ask clients to
// identify the application. Deliberately the app, never the athlete.
const USER_AGENT = "run-far route planner";
const TIMEOUT_MS = 15_000;
// A 20-mile route snapped at full resolution is a few thousand points; nothing downstream needs
// more than this to draw it, and it keeps saved rows and AI tool results small.
const MAX_GEOMETRY_POINTS = 1_500;

export class RoutingError extends Error {
  constructor(message: string, readonly code: "NO_ROUTE" | "UPSTREAM") {
    super(message);
  }
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: Array<{ distance: number; geometry: { coordinates: Array<[number, number]> } }>;
}

// Small in-process cache of routed requests. The AI planner re-routes the same shapes while it
// converges, and the web client re-snaps a segment when the athlete undoes and redoes a point;
// neither should cost the routing service another request. Keyed by rounded coordinates, so
// it's per-instance and loses nothing that matters on restart.
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60_000;
const cache = new Map<string, { at: number; value: Promise<PlannedRoute> }>();

function cacheKey(waypoints: LatLon[], withElevation: boolean): string {
  return `${withElevation ? "e" : "n"}:${waypoints.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(";")}`;
}

export function clearRoutingCache(): void {
  cache.clear();
}

/** One request to the routing service: geometry and distance only. */
async function routeLeg(waypoints: LatLon[], fetchImpl: typeof fetch): Promise<{ geometry: LatLon[]; distanceM: number }> {
  const coords = waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(";");
  const params = new URLSearchParams({ overview: "full", geometries: "geojson", continue_straight: "false" });
  if (env.ROUTING_API_KEY) params.set(env.ROUTING_API_KEY_PARAM, env.ROUTING_API_KEY);
  const url = `${env.ROUTING_URL.replace(/\/$/, "")}/${coords}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new RoutingError(`Routing service unreachable: ${(err as Error).message}`, "UPSTREAM");
  }
  const body = (await res.json().catch(() => null)) as OsrmResponse | null;
  if (!body) throw new RoutingError(`Routing service returned ${res.status}`, "UPSTREAM");
  if (body.code !== "Ok" || !body.routes?.[0]) {
    // NoRoute / NoSegment mean the points are somewhere a runner can't reach (open water, a
    // motorway-only area) — the athlete's problem to fix, not an outage.
    if (body.code === "NoRoute" || body.code === "NoSegment") {
      throw new RoutingError("No runnable path connects those points. Try moving them onto a street or trail.", "NO_ROUTE");
    }
    throw new RoutingError(body.message ?? `Routing failed (${body.code})`, "UPSTREAM");
  }
  const route = body.routes[0];
  return {
    geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon] as LatLon),
    distanceM: route.distance,
  };
}

/**
 * Snap a sequence of waypoints to runnable paths in the given order.
 *
 * Routes with more waypoints than the service accepts per request are routed in overlapping
 * chunks (each chunk starts where the last ended) and stitched, so the cap is invisible to
 * callers.
 */
export async function routeThrough(
  waypoints: LatLon[],
  fetchImpl: typeof fetch = fetch,
  options: { withElevation?: boolean } = {},
): Promise<PlannedRoute> {
  if (waypoints.length < 2) throw new RoutingError("A route needs at least two points.", "NO_ROUTE");
  const withElevation = options.withElevation ?? true;
  const key = cacheKey(waypoints, withElevation);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = (async (): Promise<PlannedRoute> => {
    const max = env.ROUTING_MAX_WAYPOINTS;
    const chunks: LatLon[][] = [];
    for (let i = 0; i < waypoints.length - 1; i += max - 1) chunks.push(waypoints.slice(i, i + max));
    const legs = await Promise.all(chunks.map((c) => routeLeg(c, fetchImpl)));
    const full: LatLon[] = [];
    for (const leg of legs) full.push(...(full.length ? leg.geometry.slice(1) : leg.geometry));
    const geometry = downsample(full, MAX_GEOMETRY_POINTS);
    const elevation = withElevation ? await elevationFor(geometry, fetchImpl) : null;
    return {
      waypoints,
      geometry,
      distanceM: Math.round(legs.reduce((sum, l) => sum + l.distanceM, 0)),
      elevationGainM: elevation?.gainM ?? null,
      elevationLossM: elevation?.lossM ?? null,
    };
  })();

  cache.set(key, { at: Date.now(), value });
  // A failed request must not be cached, or one blip pins an error for an hour.
  value.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

export type LoopShape = "loop" | "out_and_back";

/**
 * Build a route of roughly `targetM` from `start` heading toward `bearing`.
 *
 * Distance on a real street network can't be computed up front, so this guesses a size, routes
 * it, and rescales by how far off it came out — converging in two or three round trips on most
 * networks. Returns the closest attempt even if none lands inside the tolerance (a dead-end
 * peninsula can make the target unreachable in that direction); the caller sees the distance.
 */
export async function routeOfDistance(
  params: { start: LatLon; targetM: number; bearing: number; shape: LoopShape },
  fetchImpl: typeof fetch = fetch,
): Promise<PlannedRoute> {
  const { start, targetM, bearing, shape } = params;
  const TOLERANCE = 0.07;
  const MAX_ATTEMPTS = 4;

  let size = shape === "loop" ? initialLoopRadiusM(targetM) : targetM / 2 / DETOUR_FACTOR;
  let best: PlannedRoute | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const waypoints =
      shape === "loop" ? loopWaypoints(start, bearing, size) : [start, destinationPoint(start, bearing, size), start];
    // Elevation only for the attempt that's kept, not every guess on the way to it.
    const route = await routeThrough(waypoints, fetchImpl, { withElevation: false });
    if (!best || Math.abs(route.distanceM - targetM) < Math.abs(best.distanceM - targetM)) best = route;
    const ratio = targetM / Math.max(route.distanceM, 1);
    if (Math.abs(1 - ratio) <= TOLERANCE) break;
    // Damped so one wildly-off attempt (the router found a bridge on the second try) can't
    // overshoot into the opposite error.
    size *= Math.min(2, Math.max(0.5, ratio));
  }
  const elevation = await elevationFor(best!.geometry, fetchImpl);
  return { ...best!, elevationGainM: elevation?.gainM ?? null, elevationLossM: elevation?.lossM ?? null };
}

export interface NearbyPlace {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  distanceMiles: number;
  direction: string;
}

const PLACE_QUERIES: Record<string, string[]> = {
  park: ['nwr["leisure"="park"]["name"]', 'nwr["leisure"="nature_reserve"]["name"]'],
  water: ['nwr["natural"="water"]["name"]', 'way["waterway"="river"]["name"]', 'nwr["natural"="beach"]["name"]'],
  trail: ['way["highway"~"^(path|footway|cycleway|track)$"]["name"]', 'relation["route"~"^(foot|hiking|running)$"]["name"]'],
  track: ['nwr["leisure"="track"]'],
  landmark: ['nwr["tourism"="viewpoint"]["name"]', 'nwr["historic"]["name"]'],
};
export const PLACE_KINDS = Object.keys(PLACE_QUERIES);

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Named runnable features (parks, water, trails, tracks, landmarks) within `radiusM` of `center`. */
export async function findNearbyPlaces(
  params: { center: LatLon; radiusM: number; kinds: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<NearbyPlace[]> {
  const kinds = params.kinds.filter((k) => k in PLACE_QUERIES);
  const selectors = (kinds.length ? kinds : PLACE_KINDS).flatMap((k) =>
    PLACE_QUERIES[k]!.map((q) => ({ kind: k, q })),
  );
  const [lat, lon] = params.center;
  const radius = Math.round(Math.min(params.radiusM, 20_000));
  const query = `[out:json][timeout:12];(${selectors.map((s) => `${s.q}(around:${radius},${lat},${lon});`).join("")});out center tags 200;`;

  let res: Response;
  try {
    res = await fetchImpl(env.OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new RoutingError(`Place search unreachable: ${(err as Error).message}`, "UPSTREAM");
  }
  if (!res.ok) throw new RoutingError(`Place search returned ${res.status}`, "UPSTREAM");
  const body = (await res.json()) as { elements?: OverpassElement[] };

  const seen = new Set<string>();
  const places: NearbyPlace[] = [];
  for (const el of body.elements ?? []) {
    const pos = el.center ?? (el.lat != null && el.lon != null ? { lat: el.lat, lon: el.lon } : null);
    if (!pos) continue;
    const tags = el.tags ?? {};
    const kind = classify(tags);
    const name = tags.name ?? (kind === "track" ? "Running track" : null);
    if (!name) continue;
    // A named trail or river comes back as dozens of ways; one entry per name+kind is plenty.
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const point: LatLon = [pos.lat, pos.lon];
    places.push({
      name,
      kind,
      lat: Math.round(pos.lat * 1e5) / 1e5,
      lon: Math.round(pos.lon * 1e5) / 1e5,
      distanceMiles: Math.round((haversineM(params.center, point) / 1609.344) * 100) / 100,
      direction: compassPoint(bearingDeg(params.center, point)),
    });
  }
  return places.sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 40);
}

function classify(tags: Record<string, string>): string {
  if (tags.leisure === "track") return "track";
  if (tags.leisure === "park" || tags.leisure === "nature_reserve") return "park";
  if (tags.natural === "water" || tags.waterway || tags.natural === "beach") return "water";
  if (tags.highway || tags.route) return "trail";
  return "landmark";
}
