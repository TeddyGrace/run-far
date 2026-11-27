import type { LatLon } from "@run-far/shared";

/** One snapped leg between two consecutive waypoints. */
export interface Segment {
  geometry: LatLon[];
  distanceM: number;
}

const key = (a: LatLon, b: LatLon) => `${a[0].toFixed(6)},${a[1].toFixed(6)}>${b[0].toFixed(6)},${b[1].toFixed(6)}`;

/**
 * Snapped legs keyed by their endpoints, so editing a route only routes the legs that changed:
 * adding a point routes one new leg, dragging one routes two, and undo/redo or an out-and-back
 * reuses legs already routed. A leg run the other way is the same path reversed (foot routing
 * ignores one-way streets), so it's served from the forward entry.
 */
export class SegmentCache {
  private map = new Map<string, Segment>();
  constructor(private readonly max = 400) {}

  get(a: LatLon, b: LatLon): Segment | undefined {
    const fwd = this.map.get(key(a, b));
    if (fwd) return fwd;
    const rev = this.map.get(key(b, a));
    return rev ? { geometry: [...rev.geometry].reverse(), distanceM: rev.distanceM } : undefined;
  }

  set(a: LatLon, b: LatLon, seg: Segment): void {
    this.map.set(key(a, b), seg);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** Consecutive waypoint pairs: the legs a route is made of. */
export function legsOf(waypoints: LatLon[]): Array<[LatLon, LatLon]> {
  const legs: Array<[LatLon, LatLon]> = [];
  for (let i = 1; i < waypoints.length; i++) legs.push([waypoints[i - 1]!, waypoints[i]!]);
  return legs;
}

/** Join legs into one polyline without repeating each shared join point. */
export function stitch(segments: Segment[]): { geometry: LatLon[]; distanceM: number } {
  const geometry: LatLon[] = [];
  let distanceM = 0;
  for (const s of segments) {
    geometry.push(...(geometry.length ? s.geometry.slice(1) : s.geometry));
    distanceM += s.distanceM;
  }
  return { geometry, distanceM: Math.round(distanceM) };
}

/** Run `fn` over `items` with at most `limit` in flight — keeps a long reopened route from
 * firing dozens of routing requests at once. Results are in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export const FEET_PER_METER = 3.28084;
