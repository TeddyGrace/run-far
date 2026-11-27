import { describe, expect, it } from "vitest";
import type { LatLon } from "@run-far/shared";
import { bearingDeg, destinationPoint, downsample, haversineM, loopWaypoints } from "./geo.js";
import { RoutingError, findNearbyPlaces, routeOfDistance, routeThrough } from "./routingClient.js";
import { executeRouteTool } from "../anthropic/routePlanner.js";

const START: LatLon = [40.7812, -73.9665];

/** A fake OSRM: echoes the waypoints back as the geometry and reports their straight-line
 * length times a detour ratio, which is enough to exercise distance-targeting logic. */
function fakeOsrm(detour = 1.4, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const coords = url.split("/foot/")[1]!.split("?")[0]!.split(";").map((c) => {
      const [lon, lat] = c.split(",").map(Number);
      return [lon!, lat!] as [number, number];
    });
    let d = 0;
    for (let i = 1; i < coords.length; i++) {
      d += haversineM([coords[i - 1]![1], coords[i - 1]![0]], [coords[i]![1], coords[i]![0]]);
    }
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: d * detour, geometry: { coordinates: coords } }] }));
  }) as typeof fetch;
}

describe("geo", () => {
  it("destinationPoint lands the requested distance away on the requested bearing", () => {
    const p = destinationPoint(START, 90, 5_000);
    expect(haversineM(START, p)).toBeCloseTo(5_000, -1);
    expect(bearingDeg(START, p)).toBeCloseTo(90, 0);
  });

  it("loopWaypoints starts and ends at the start and heads out along the bearing", () => {
    const pts = loopWaypoints(START, 0, 1_000, 3);
    expect(pts[0]).toEqual(START);
    expect(pts[pts.length - 1]).toEqual(START);
    expect(pts).toHaveLength(5);
    // The middle turnaround point is diametrically opposite the start: ~2r due north.
    expect(haversineM(START, pts[2]!)).toBeCloseTo(2_000, -1);
    expect(bearingDeg(START, pts[2]!)).toBeCloseTo(0, 0);
  });

  it("downsample keeps both endpoints and caps the length", () => {
    const line: LatLon[] = Array.from({ length: 1000 }, (_, i) => [i, 0]);
    const out = downsample(line, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual([0, 0]);
    expect(out[9]).toEqual([999, 0]);
  });
});

describe("routeThrough", () => {
  it("converts OSRM [lon, lat] geometry to [lat, lon]", async () => {
    const route = await routeThrough([START, [40.79, -73.96]], fakeOsrm(1));
    expect(route.geometry[0]).toEqual(START);
    expect(route.distanceM).toBeGreaterThan(0);
  });

  it("reports an unreachable point as NO_ROUTE rather than an outage", async () => {
    const f = (async () => new Response(JSON.stringify({ code: "NoRoute" }))) as unknown as typeof fetch;
    await expect(routeThrough([START, [40, -70]], f)).rejects.toMatchObject({ code: "NO_ROUTE" });
    await expect(routeThrough([START, [40, -70]], f)).rejects.toBeInstanceOf(RoutingError);
  });
});

describe("routeOfDistance", () => {
  it.each(["loop", "out_and_back"] as const)("converges on the target distance for a %s", async (shape) => {
    const targetM = 8_047; // 5 mi
    const route = await routeOfDistance({ start: START, targetM, bearing: 45, shape }, fakeOsrm(1.6));
    expect(Math.abs(route.distanceM - targetM) / targetM).toBeLessThan(0.07);
  });

  it("stops after one call when the first guess is already within tolerance", async () => {
    const calls: string[] = [];
    // Detour 1.3 matches the generator's own seed assumption, so the first loop is on target
    // up to the chord-vs-arc difference of a 4-point polygon.
    await routeOfDistance({ start: START, targetM: 5_000, bearing: 0, shape: "out_and_back" }, fakeOsrm(1.3, calls));
    expect(calls).toHaveLength(1);
  });
});

describe("findNearbyPlaces", () => {
  it("dedupes repeated ways by name and sorts by distance", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          elements: [
            { type: "way", center: { lat: 40.8, lon: -73.96 }, tags: { highway: "path", name: "River Trail" } },
            { type: "way", center: { lat: 40.801, lon: -73.96 }, tags: { highway: "path", name: "River Trail" } },
            { type: "way", center: { lat: 40.782, lon: -73.966 }, tags: { leisure: "park", name: "Little Park" } },
            { type: "node", lat: 40.79, lon: -73.97, tags: { leisure: "track" } },
            { type: "way", tags: { leisure: "park", name: "No position" } },
          ],
        }),
      )) as unknown as typeof fetch;
    const places = await findNearbyPlaces({ center: START, radiusM: 3_000, kinds: [] }, f);
    expect(places.map((p) => p.name)).toEqual(["Little Park", "Running track", "River Trail"]);
    expect(places[2]!.kind).toBe("trail");
  });
});

describe("executeRouteTool", () => {
  it("builds, then presents, a route by id", async () => {
    const state = { start: START, routes: new Map(), presented: null };
    const built = (await executeRouteTool(
      "build_route_of_distance",
      { target_miles: 3, direction_degrees: 180, shape: "loop" },
      state,
      fakeOsrm(1.5),
    )) as { route_id: string; distance_miles: number; ends_at_start: boolean };
    expect(built.route_id).toBe("r1");
    expect(built.distance_miles).toBeGreaterThan(2.7);
    expect(built.distance_miles).toBeLessThan(3.3);
    expect(built.ends_at_start).toBe(true);

    const bad = await executeRouteTool("present_route", { route_id: "r9", name: "x", summary: "y" }, state);
    expect(bad).toMatchObject({ error: expect.stringContaining("r1") });

    await executeRouteTool("present_route", { route_id: "r1", name: "South loop", summary: "A loop." }, state);
    expect(state.presented).toMatchObject({ name: "South loop", summary: "A loop." });
  });

  it("refuses points implausibly far from the start", async () => {
    const state = { start: START, routes: new Map(), presented: null };
    const out = await executeRouteTool(
      "build_route_through",
      { points: [{ lat: 34.05, lon: -118.24 }], return_to_start: true },
      state,
      fakeOsrm(),
    );
    expect(out).toMatchObject({ error: expect.stringContaining("25 miles") });
  });
});
