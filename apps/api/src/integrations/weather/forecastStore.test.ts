import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

/**
 * The read-through forecast cache.
 *
 * The point of this module is that a dashboard read stops making NWS calls, so the assertions
 * are mostly about call *counts* — a correctness test that never checked how often the network
 * was touched would pass just as happily against the code this replaced.
 */
import type { DailyForecast, NwsAlert, WeatherHour } from "./weatherClient.js";

const nws = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  forecasts: [] as DailyForecast[],
}));

vi.mock("./weatherClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./weatherClient.js")>();
  return {
    ...actual,
    getDailyForecasts: async () => {
      nws.calls += 1;
      if (nws.fail) throw new Error("NWS down");
      return nws.forecasts;
    },
  };
});

const { db } = await import("../../db/client.js");
const { users, weatherForecasts } = await import("../../db/schema.js");
const { getForecastsForRules, invalidateForecasts, FORECAST_TTL_MS } = await import(
  "./forecastStore.js"
);
const { eq } = await import("drizzle-orm");

const TZ = "America/New_York";
const NOW = new Date("2025-06-11T15:00:00-04:00");

let userId: string;

function forecast(date: string, highTempF: number): DailyForecast {
  return {
    date,
    highTempF,
    lowTempF: 55,
    shortForecast: "Sunny",
    precipProbabilityPct: 10,
    windSpeed: "5 mph",
    windDirection: "NW",
    iconUrl: null,
    iconCode: "clear",
    hourly: [],
    segments: [],
    alerts: [],
  };
}

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `forecast-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      timezone: TZ,
    })
    .returning({ id: users.id });
  userId = user!.id;
  nws.calls = 0;
  nws.fail = false;
  nws.forecasts = [forecast("2025-06-11", 78), forecast("2025-06-12", 91)];
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

const read = (now: Date = NOW) => getForecastsForRules(userId, 40.7, -74, TZ, 10, now);

describe("getForecastsForRules", () => {
  it("fetches once and persists, then serves the stored rows without touching NWS", async () => {
    const first = await read();
    expect(nws.calls).toBe(1);
    expect(first).toHaveLength(2);

    const second = await read();
    // The whole point: a second dashboard read inside the TTL costs zero NWS calls, where it
    // used to cost three.
    expect(nws.calls).toBe(1);
    expect(second.map((f) => f.highTempF)).toEqual([78, 91]);
  });

  it("round-trips the forecast through the database faithfully", async () => {
    const alert: NwsAlert = {
      event: "Heat Advisory",
      severity: "Moderate",
      headline: "Hot",
      description: "Heat index up to 105.",
      effective: "2025-06-11T12:00:00Z",
      expires: "2025-06-11T23:00:00Z",
    };
    const hour: WeatherHour = {
      time: "2025-06-11T09:00:00-04:00",
      tempF: 70,
      precipPct: 5,
      iconCode: "clear",
      shortForecast: "Sunny",
      windSpeed: "4 mph",
      windDirection: "NW",
      isDaytime: true,
    };
    nws.forecasts = [{ ...forecast("2025-06-11", 78), hourly: [hour], alerts: [alert] }];
    await read();
    const cached = await read();

    // Served from Postgres on the second call, so the jsonb columns have to come back as the
    // same shapes the rules read — a silent {} here would switch the advisory rule off.
    expect(cached[0]?.alerts).toEqual([alert]);
    expect(cached[0]?.hourly).toEqual([hour]);
  });

  it("refetches once the stored rows age past the TTL", async () => {
    await read();
    expect(nws.calls).toBe(1);

    await read(new Date(NOW.getTime() + FORECAST_TTL_MS + 1_000));
    expect(nws.calls).toBe(2);
  });

  it("falls back to stale stored rows when NWS is down rather than going blind", async () => {
    await read();
    nws.fail = true;

    const later = await read(new Date(NOW.getTime() + FORECAST_TTL_MS + 1_000));

    // The previous behaviour was an empty array here, which silently switched the weather rule
    // off for the length of the outage. Yesterday's forecast beats no forecast.
    expect(nws.calls).toBe(2);
    expect(later.map((f) => f.highTempF)).toEqual([78, 91]);
  });

  it("returns nothing when NWS fails and there is nothing stored", async () => {
    nws.fail = true;
    await expect(read()).resolves.toEqual([]);
  });

  it("upserts rather than duplicating when a date is refetched", async () => {
    await read();
    nws.forecasts = [forecast("2025-06-11", 99), forecast("2025-06-12", 91)];
    const refreshed = await read(new Date(NOW.getTime() + FORECAST_TTL_MS + 1_000));

    expect(refreshed[0]?.highTempF).toBe(99);
    const rows = await db
      .select()
      .from(weatherForecasts)
      .where(eq(weatherForecasts.userId, userId));
    expect(rows).toHaveLength(2);
  });

  it("ignores stored rows for days already past", async () => {
    // Yesterday's row is not evidence that today's forecast is current — treating it as such
    // would serve a stale window every morning.
    await db.insert(weatherForecasts).values({
      userId,
      date: "2025-06-10",
      highTempF: 60,
      fetchedAt: NOW,
    });

    await read();
    expect(nws.calls).toBe(1);
  });

  it("refetches after a location change clears the stored rows", async () => {
    await read();
    expect(nws.calls).toBe(1);

    await invalidateForecasts(userId);
    await read();

    // Rows record a date but not the coordinates they were fetched for, so a move has to drop
    // them or the athlete is served the old city's weather until the TTL lapses.
    expect(nws.calls).toBe(2);
  });
});
