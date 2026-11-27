import type { LatLon } from "@run-far/shared";

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a[0]);
  const φ2 = toRad(b[0]);
  const Δλ = toRad(b[1] - a[1]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `distanceM` from `origin` along `bearing` (degrees clockwise from north). */
export function destinationPoint(origin: LatLon, bearing: number, distanceM: number): LatLon {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(bearing);
  const φ1 = toRad(origin[0]);
  const λ1 = toRad(origin[1]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [round6(toDeg(φ2)), round6(((toDeg(λ2) + 540) % 360) - 180)];
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export function compassPoint(bearing: number): string {
  return COMPASS[Math.round(bearing / 45) % 8]!;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Waypoints for a loop that starts and ends at `start` and heads out along `bearing`.
 *
 * The loop is a circle of radius `radiusM` that passes through the start, with its centre
 * `radiusM` away along `bearing`; `points` evenly spaced points on it (excluding the start) are
 * the turnaround markers the router threads. Three or four points is the useful range — fewer
 * collapses into an out-and-back, more makes the router zig-zag to hit each one.
 */
export function loopWaypoints(start: LatLon, bearing: number, radiusM: number, points = 3): LatLon[] {
  const centre = destinationPoint(start, bearing, radiusM);
  const backToStart = (bearing + 180) % 360;
  const out: LatLon[] = [start];
  for (let i = 1; i <= points; i++) {
    out.push(destinationPoint(centre, backToStart + (360 * i) / (points + 1), radiusM));
  }
  out.push(start);
  return out;
}

/**
 * Street networks aren't circles: a route through points on a circle of circumference C comes
 * out longer than C because paths don't run along the arc. 1.3 is a typical urban/suburban
 * detour ratio; it only seeds the first guess, and the generator rescales from the measured
 * distance after that.
 */
export const DETOUR_FACTOR = 1.3;

export function initialLoopRadiusM(targetM: number): number {
  return targetM / (2 * Math.PI * DETOUR_FACTOR);
}

/** Thin a polyline to at most `max` points by even stride, always keeping both endpoints. */
export function downsample(points: LatLon[], max: number): LatLon[] {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: LatLon[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]!);
  return out;
}
