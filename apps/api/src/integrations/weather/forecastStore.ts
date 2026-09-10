import { and, asc, eq, gte, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { weatherForecasts } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";
import { getDailyForecasts } from "./weatherClient.js";
import type { DailyForecast, NwsAlert, WeatherHour, WeatherIconCode, WeatherSegment } from "./weatherClient.js";

/**
 * How long a persisted forecast is treated as current.
 *
 * NWS republishes its gridded forecast roughly hourly, so a value much below that buys nothing
 * but request volume. Thirty minutes keeps a dashboard reload from ever showing an athlete a
 * forecast they'd call stale while cutting the common case — several reloads in a sitting — from
 * three NWS calls each to none.
 *
 * The cost is bounded and named: an active weather alert can be up to this old before the
 * advisory rule sees it. Acceptable because this is a training app reasoning about whether a
 * long run will be unpleasant, not a warning system — NWS itself is the authority an athlete
 * would act on for anything urgent.
 */
export const FORECAST_TTL_MS = 30 * 60_000;

type ForecastRow = typeof weatherForecasts.$inferSelect;

function toDailyForecast(row: ForecastRow): DailyForecast {
  return {
    date: row.date,
    highTempF: row.highTempF,
    lowTempF: row.lowTempF,
    shortForecast: row.shortForecast,
    precipProbabilityPct: row.precipProbabilityPct,
    windSpeed: row.windSpeed,
    windDirection: row.windDirection,
    iconUrl: row.iconUrl,
    iconCode: row.iconCode as WeatherIconCode | null,
    hourly: (row.hourly ?? []) as WeatherHour[],
    segments: (row.segments ?? []) as WeatherSegment[],
    alerts: (row.alerts ?? []) as NwsAlert[],
  };
}

async function readPersisted(userId: string, fromYmd: string): Promise<ForecastRow[]> {
  return db
    .select()
    .from(weatherForecasts)
    .where(and(eq(weatherForecasts.userId, userId), gte(weatherForecasts.date, fromYmd)))
    .orderBy(asc(weatherForecasts.date));
}

/** `excluded.<col>` — the value the row *would* have been inserted with. A multi-row upsert has
 * no single literal to set each column to, unlike the row-at-a-time version this replaces where
 * the values were still in scope. */
function excluded(column: string) {
  return sql.raw(`excluded."${column}"`);
}

async function persist(userId: string, forecasts: DailyForecast[], fetchedAt: Date): Promise<void> {
  if (forecasts.length === 0) return;
  const values = forecasts.map((day) => ({
    userId,
    date: day.date,
    highTempF: day.highTempF,
    lowTempF: day.lowTempF,
    shortForecast: day.shortForecast,
    precipProbabilityPct: day.precipProbabilityPct,
    windSpeed: day.windSpeed,
    windDirection: day.windDirection,
    iconUrl: day.iconUrl,
    iconCode: day.iconCode,
    hourly: day.hourly,
    segments: day.segments,
    alerts: day.alerts,
    fetchedAt,
  }));

  // One statement rather than the row-at-a-time loop this replaces: a ten-day forecast was ten
  // sequential round-trips on a path that already had three HTTP calls in front of it.
  await db
    .insert(weatherForecasts)
    .values(values)
    .onConflictDoUpdate({
      target: [weatherForecasts.userId, weatherForecasts.date],
      set: {
        highTempF: excluded("high_temp_f"),
        lowTempF: excluded("low_temp_f"),
        shortForecast: excluded("short_forecast"),
        precipProbabilityPct: excluded("precip_probability_pct"),
        windSpeed: excluded("wind_speed"),
        windDirection: excluded("wind_direction"),
        iconUrl: excluded("icon_url"),
        iconCode: excluded("icon_code"),
        hourly: excluded("hourly"),
        segments: excluded("segments"),
        alerts: excluded("alerts"),
        fetchedAt: excluded("fetched_at"),
        updatedAt: new Date(),
      },
    });
}

/**
 * Drop a user's persisted forecasts. Called when their location changes: the rows record a date
 * but not the coordinates they were fetched for, so without this a move would be served the old
 * city's weather until the TTL lapsed.
 */
export async function invalidateForecasts(userId: string): Promise<void> {
  await db.delete(weatherForecasts).where(eq(weatherForecasts.userId, userId));
}

/**
 * The forecast the rules engine should reason about, read through a cache.
 *
 * Every dashboard load used to refetch NWS — three HTTP calls plus a per-day upsert — on the
 * request path, purely as a side effect of regenerating recommendations. This serves the
 * persisted rows when they are recent enough and only reaches for the network otherwise.
 *
 * On a fetch failure it falls back to whatever is persisted, however old. That is a change in
 * behaviour and a deliberate one: the previous code caught the error and continued with an
 * empty forecast, which silently switched the weather rule off for the duration of an NWS
 * outage. Yesterday's forecast is a much better basis for "Saturday's long run will be hot"
 * than no forecast at all.
 */
export async function getForecastsForRules(
  userId: string,
  lat: number,
  lon: number,
  timeZone: string,
  days: number,
  now: Date = new Date(),
): Promise<DailyForecast[]> {
  const todayYmd = dateYmdInZone(now, timeZone);
  const persisted = await readPersisted(userId, todayYmd);

  const newestFetch = persisted.reduce<number>((acc, r) => Math.max(acc, r.fetchedAt.getTime()), 0);
  const isFresh = persisted.length > 0 && now.getTime() - newestFetch < FORECAST_TTL_MS;
  if (isFresh) return persisted.slice(0, days).map(toDailyForecast);

  try {
    const fresh = await getDailyForecasts(lat, lon, timeZone, days);
    await persist(userId, fresh, now);
    return fresh;
  } catch (err) {
    logger.warn(
      { err, userId, persistedDays: persisted.length },
      "NWS forecast fetch failed; falling back to persisted forecast",
    );
    return persisted.slice(0, days).map(toDailyForecast);
  }
}
