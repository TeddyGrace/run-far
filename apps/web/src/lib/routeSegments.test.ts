import { describe, expect, it } from "vitest";
import type { LatLon } from "@run-far/shared";
import { SegmentCache, legsOf, mapLimit, stitch } from "./routeSegments.js";

const A: LatLon = [40, -73];
const B: LatLon = [40.01, -73];
const C: LatLon = [40.01, -73.01];

describe("SegmentCache", () => {
  it("serves a leg run backwards from the forward entry, reversed", () => {
    const cache = new SegmentCache();
    cache.set(A, B, { geometry: [A, [40.005, -72.999], B], distanceM: 1200 });
    expect(cache.get(B, A)).toEqual({ geometry: [B, [40.005, -72.999], A], distanceM: 1200 });
    expect(cache.get(A, C)).toBeUndefined();
  });

  it("evicts the oldest entry past its cap", () => {
    const cache = new SegmentCache(2);
    cache.set(A, B, { geometry: [A, B], distanceM: 1 });
    cache.set(B, C, { geometry: [B, C], distanceM: 1 });
    cache.set(C, A, { geometry: [C, A], distanceM: 1 });
    expect(cache.get(A, B)).toBeUndefined();
    expect(cache.get(C, A)).toBeDefined();
  });
});

describe("stitch", () => {
  it("joins legs without duplicating join points and sums distance", () => {
    const route = stitch([
      { geometry: [A, B], distanceM: 1000.4 },
      { geometry: [B, C], distanceM: 900.3 },
    ]);
    expect(route.geometry).toEqual([A, B, C]);
    expect(route.distanceM).toBe(1901);
  });

  it("an out-and-back is all cache hits after the way out", () => {
    const out = [A, B, C];
    const waypoints = [...out, ...out.slice(0, -1).reverse()];
    const cache = new SegmentCache();
    for (const [a, b] of legsOf(out)) cache.set(a, b, { geometry: [a, b], distanceM: 1 });
    expect(legsOf(waypoints).every(([a, b]) => cache.get(a, b))).toBe(true);
  });
});

describe("mapLimit", () => {
  it("keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 * (7 - n)));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});
