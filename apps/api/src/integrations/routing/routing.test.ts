import { beforeEach, describe, expect, it } from "vitest";
import type { LatLon } from "@run-far/shared";
import { bearingDeg, destinationPoint, downsample, haversineM, loopWaypoints } from "./geo.js";
import { RoutingError, clearRoutingCache, findNearbyPlaces, routeOfDistance, routeThrough } from "./routingClient.js";
import { gainAndLoss, sampleAlong } from "./elevation.js";
import { executeRouteTool } from "../anthropic/routePlanner.js";

const START: LatLon = [40.7812, -73.9665];

beforeEach(() => clearRoutingCache());

/** A fake OSRM: echoes the waypoints back as the geometry and reports their straight-line
 * length times a detour ratio, which is enough to exercise distance-targeting logic. Also
 * answers the elevation service with a steady 1m-per-sample climb (`elevationCalls` counts). */
function fakeOsrm(detour = 1.4, calls: string[] = [], elevationCalls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("locations=")) {
      elevationCalls.push(url);
      const n = decodeURIComponent(url.split("locations=")[1]!).split("|").length;
      return new Response(JSON.stringify({ status: "OK", results: Array.from({ length: n }, (_, i) => ({ elevation: 10 + i })) }));
    }
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

describe("routeThrough caching and chunking", () => {
  it("answers a repeated request from cache", async () => {
    const calls: string[] = [];
    const f = fakeOsrm(1, calls);
    await routeThrough([START, [40.79, -73.96]], f);
    await routeThrough([START, [40.79, -73.96]], f);
    expect(calls).toHaveLength(1);
  });

  it("does not cache a failure", async () => {
    let n = 0;
    const flaky = (async (input: string | URL | Request) => {
      if (n++ === 0) throw new Error("socket hang up");
      return fakeOsrm(1)(input);
    }) as typeof fetch;
    await expect(routeThrough([START, [40.79, -73.96]], flaky)).rejects.toMatchObject({ code: "UPSTREAM" });
    await expect(routeThrough([START, [40.79, -73.96]], flaky)).resolves.toMatchObject({ distanceM: expect.any(Number) });
  });

  it("splits a route longer than the waypoint cap into stitched requests", async () => {
    const calls: string[] = [];
    const waypoints: LatLon[] = Array.from({ length: 30 }, (_, i) => [40.78 + i * 0.001, -73.96]);
    const route = await routeThrough(waypoints, fakeOsrm(1, calls));
    expect(calls).toHaveLength(2); // cap is 25: points 0-24, then 24-29
    // Stitched without repeating the shared join point.
    expect(route.geometry).toHaveLength(30);
    const straight = haversineM(waypoints[0]!, waypoints[29]!);
    expect(route.distanceM).toBeCloseTo(straight, -1);
  });
});

describe("elevation", () => {
  it("ignores sub-threshold DEM noise but counts real climbs and descents", () => {
    expect(gainAndLoss([10, 11, 10, 12, 10, 11, 10])).toEqual({ gainM: 0, lossM: 0 });
    expect(gainAndLoss([10, 20, 30, 25, 15])).toEqual({ gainM: 20, lossM: 15 });
  });

  it("samples evenly by distance, keeping both ends", () => {
    const line: LatLon[] = [[0, 0], [0, 0.001], [0, 0.01]];
    const out = sampleAlong(line, 11);
    expect(out).toHaveLength(11);
    expect(out[0]).toEqual([0, 0]);
    expect(out[10]![1]).toBeCloseTo(0.01, 6);
    expect(out[5]![1]).toBeCloseTo(0.005, 6);
  });

  it("attaches climb to a routed path, and reports unknown when the service fails", async () => {
    const route = await routeThrough([START, [40.79, -73.96]], fakeOsrm(1));
    expect(route.elevationGainM).toBeGreaterThan(0);
    expect(route.elevationLossM).toBe(0);

    clearRoutingCache();
    const noElevation = (async (input: string | URL | Request) =>
      String(input).includes("locations=") ? new Response("busy", { status: 429 }) : fakeOsrm(1)(input)) as typeof fetch;
    const r2 = await routeThrough([START, [40.79, -73.96]], noElevation);
    expect(r2.distanceM).toBeGreaterThan(0);
    expect(r2.elevationGainM).toBeNull();
  });
});

describe("routeOfDistance", () => {
  it("looks up elevation once, for the kept attempt only", async () => {
    const elevationCalls: string[] = [];
    await routeOfDistance({ start: START, targetM: 8_047, bearing: 45, shape: "loop" }, fakeOsrm(1.6, [], elevationCalls));
    expect(elevationCalls).toHaveLength(1);
  });

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
