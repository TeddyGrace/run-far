import type { LatLon, PlannedRoute } from "@run-far/shared";
import { env } from "../../env.js";
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

/** Snap a sequence of waypoints to runnable paths (OSRM foot profile) in the given order. */
export async function routeThrough(waypoints: LatLon[], fetchImpl: typeof fetch = fetch): Promise<PlannedRoute> {
  if (waypoints.length < 2) throw new RoutingError("A route needs at least two points.", "NO_ROUTE");
  const coords = waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(";");
  const url = `${env.ROUTING_BASE_URL.replace(/\/$/, "")}/route/v1/foot/${coords}?overview=full&geometries=geojson&continue_straight=false`;

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
  const geometry = downsample(
    route.geometry.coordinates.map(([lon, lat]) => [lat, lon] as LatLon),
    MAX_GEOMETRY_POINTS,
  );
  return { waypoints, geometry, distanceM: Math.round(route.distance) };
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
    const route = await routeThrough(waypoints, fetchImpl);
    if (!best || Math.abs(route.distanceM - targetM) < Math.abs(best.distanceM - targetM)) best = route;
    const ratio = targetM / Math.max(route.distanceM, 1);
    if (Math.abs(1 - ratio) <= TOLERANCE) break;
    // Damped so one wildly-off attempt (the router found a bridge on the second try) can't
    // overshoot into the opposite error.
    size *= Math.min(2, Math.max(0.5, ratio));
  }
  return best!;
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
  const query = `[out:json][timeout:20];(${selectors.map((s) => `${s.q}(around:${radius},${lat},${lon});`).join("")});out center tags 200;`;

  let res: Response;
  try {
    res = await fetchImpl(env.OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(25_000),
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
