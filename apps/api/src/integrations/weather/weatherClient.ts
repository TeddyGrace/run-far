import { dateYmdInZone, zonedLocalToIso } from "../../lib/zonedTime.js";

const USER_AGENT = "run-far (contact: teddygrace77@gmail.com)";
const NWS_BASE = "https://api.weather.gov";

// NWS documents the lat/lon -> gridpoint mapping as stable and asks callers not to
// re-resolve it on every request.
const forecastUrlCache = new Map<string, string>();

export interface NwsForecastPeriod {
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  probabilityOfPrecipitation: { value: number | null };
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  icon: string;
}

export interface NwsAlert {
  event: string;
  severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
  headline: string | null;
  description: string;
  effective: string;
  expires: string;
}

export interface DailyForecast {
  date: string; // YYYY-MM-DD, athlete-local
  highTempF: number | null;
  lowTempF: number | null;
  shortForecast: string | null;
  precipProbabilityPct: number | null;
  windSpeed: string | null;
  windDirection: string | null;
  iconUrl: string | null;
  alerts: NwsAlert[];
}

async function nwsFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`NWS request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

async function resolveForecastUrl(lat: number, lon: number): Promise<string> {
  const key = `${lat},${lon}`;
  const cached = forecastUrlCache.get(key);
  if (cached) return cached;

  const point = await nwsFetch<{ properties: { forecast: string } }>(`${NWS_BASE}/points/${lat},${lon}`);
  const forecastUrl = point.properties.forecast;
  forecastUrlCache.set(key, forecastUrl);
  return forecastUrl;
}

async function fetchPeriods(lat: number, lon: number): Promise<NwsForecastPeriod[]> {
  const forecastUrl = await resolveForecastUrl(lat, lon);
  const forecast = await nwsFetch<{ properties: { periods: NwsForecastPeriod[] } }>(forecastUrl);
  return forecast.properties.periods;
}

async function fetchActiveAlerts(lat: number, lon: number): Promise<NwsAlert[]> {
  const alerts = await nwsFetch<{ features: Array<{ properties: NwsAlert }> }>(
    `${NWS_BASE}/alerts/active?point=${lat},${lon}`,
  );
  return alerts.features.map((f) => f.properties);
}

/** Groups NWS's 12h day/night periods into one row per athlete-local calendar date, and
 * attaches any active alert whose effective/expires window overlaps that date. Periods are
 * bucketed by the local date of their `startTime` (not endTime), so an evening period that
 * crosses a UTC day boundary still lands on the day it starts. */
export function toDailyForecasts(
  periods: NwsForecastPeriod[],
  alerts: NwsAlert[],
  timeZone: string,
): DailyForecast[] {
  const buckets = new Map<string, { day?: NwsForecastPeriod; night?: NwsForecastPeriod }>();
  for (const period of periods) {
    const ymd = dateYmdInZone(new Date(period.startTime), timeZone);
    const bucket = buckets.get(ymd) ?? {};
    if (period.isDaytime) bucket.day ??= period;
    else bucket.night ??= period;
    buckets.set(ymd, bucket);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { day, night }]) => {
      const dayStartIso = zonedLocalToIso(date, "00:00", timeZone);
      const dayEndIso = new Date(new Date(dayStartIso).getTime() + 24 * 60 * 60_000).toISOString();
      const dayAlerts = alerts.filter((a) => a.effective < dayEndIso && a.expires > dayStartIso);

      return {
        date,
        highTempF: day?.temperature ?? null,
        lowTempF: night?.temperature ?? day?.temperature ?? null,
        shortForecast: day?.shortForecast ?? night?.shortForecast ?? null,
        precipProbabilityPct: day?.probabilityOfPrecipitation.value ?? night?.probabilityOfPrecipitation.value ?? null,
        windSpeed: day?.windSpeed ?? night?.windSpeed ?? null,
        windDirection: day?.windDirection ?? night?.windDirection ?? null,
        iconUrl: day?.icon ?? night?.icon ?? null,
        alerts: dayAlerts,
      };
    });
}

/** NWS daily forecasts for the next `days` calendar dates (athlete-local). Throws on
 * network/HTTP failure — callers should catch and fall back, same as getPrimaryBusyPeriods. */
export async function getDailyForecasts(
  lat: number,
  lon: number,
  timeZone: string,
  days = 10,
): Promise<DailyForecast[]> {
  const [periods, alerts] = await Promise.all([fetchPeriods(lat, lon), fetchActiveAlerts(lat, lon)]);
  return toDailyForecasts(periods, alerts, timeZone).slice(0, days);
}

/** Live forecast for an explicit date range — used by the assistant's get_weather tool for
 * ad-hoc freshness rather than reading the persisted table. */
export async function getForecastForRange(
  lat: number,
  lon: number,
  timeZone: string,
  fromYmd: string,
  toYmd: string,
): Promise<DailyForecast[]> {
  const daily = await getDailyForecasts(lat, lon, timeZone, 10);
  return daily.filter((d) => d.date >= fromYmd && d.date <= toYmd);
}
