import type { LatLon } from "@run-far/shared";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { haversineM } from "./geo.js";

// OpenTopoData's documented per-request maximum, and the public instance's.
const MAX_LOCATIONS = 100;
// DEM samples are noisy at the metre scale; summing every wiggle over a few hundred samples
// reports hundreds of feet of "climb" on a flat riverside path. A change only counts once the
// elevation has moved this far from the last counted point (a hysteresis band), which is the
// standard way fitness apps keep gain honest.
const HYSTERESIS_M = 3;

export interface ElevationSummary {
  gainM: number;
  lossM: number;
}

/** Evenly spaced points along a polyline by distance (not by vertex index — a route's
 * vertices bunch up on curves and thin out on straights). Always includes both ends. */
export function sampleAlong(points: LatLon[], count: number): LatLon[] {
  if (points.length < 2) return points;
  if (count <= 2) return [points[0]!, points[points.length - 1]!];
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + haversineM(points[i - 1]!, points[i]!));
  const total = cumulative[cumulative.length - 1]!;
  if (total === 0) return [points[0]!];
  const out: LatLon[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (seg < points.length - 1 && cumulative[seg]! < target) seg++;
    const a = points[seg - 1]!;
    const b = points[seg]!;
    const span = cumulative[seg]! - cumulative[seg - 1]!;
    const t = span === 0 ? 0 : Math.min(1, Math.max(0, (target - cumulative[seg - 1]!) / span));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

export function gainAndLoss(elevations: number[]): ElevationSummary {
  let gainM = 0;
  let lossM = 0;
  let anchor = elevations[0];
  if (anchor === undefined) return { gainM, lossM };
  for (const e of elevations.slice(1)) {
    const delta = e - anchor;
    if (delta >= HYSTERESIS_M) {
      gainM += delta;
      anchor = e;
    } else if (delta <= -HYSTERESIS_M) {
      lossM -= delta;
      anchor = e;
    }
  }
  return { gainM: Math.round(gainM), lossM: Math.round(lossM) };
}

export function isElevationEnabled(): boolean {
  return Boolean(env.ELEVATION_URL);
}

/**
 * Climb and descent along a route, or null when elevation is off or the service failed.
 * Elevation is a nice-to-have on top of a route that is already correct, so a failure here
 * never fails the route — it's logged and reported as unknown.
 */
export async function elevationFor(geometry: LatLon[], fetchImpl: typeof fetch = fetch): Promise<ElevationSummary | null> {
  if (!isElevationEnabled() || geometry.length < 2) return null;
  const samples = sampleAlong(geometry, MAX_LOCATIONS);
  const locations = samples.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join("|");
  try {
    const res = await fetchImpl(`${env.ELEVATION_URL}?locations=${encodeURIComponent(locations)}`, {
      headers: { "User-Agent": "run-far route planner" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`elevation service returned ${res.status}`);
    const body = (await res.json()) as { status?: string; results?: Array<{ elevation: number | null }> };
    const elevations = (body.results ?? []).map((r) => r.elevation).filter((e): e is number => typeof e === "number");
    // Mostly-missing data (over open water, outside the DEM's coverage) would understate climb.
    if (elevations.length < samples.length * 0.8) return null;
    return gainAndLoss(elevations);
  } catch (err) {
    logger.warn({ err }, "elevation lookup failed; route returned without elevation");
    return null;
  }
}
