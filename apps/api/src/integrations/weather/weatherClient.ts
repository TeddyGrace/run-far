import { dateYmdInZone, hourInZone, zonedLocalToIso } from "../../lib/zonedTime.js";
import { env } from "../../env.js";

// NWS wants a contact for the app operator, not the athlete making the request — this is
// deliberately not per-user.
const USER_AGENT = `run-far (contact: ${env.NWS_CONTACT_EMAIL})`;
const NWS_BASE = "https://api.weather.gov";

// NWS documents the lat/lon -> gridpoint mapping as stable and asks callers not to
// re-resolve it on every request.
const forecastUrlCache = new Map<string, { forecast: string; forecastHourly: string }>();

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

/** Small, stable set of condition glyphs the frontend renders as hand-drawn SVG icons —
 * decoupled from NWS's own icon taxonomy so a new NWS condition string never breaks the UI. */
export type WeatherIconCode =
  | "clear"
  | "few"
  | "clouds"
  | "overcast"
  | "fog"
  | "rain"
  | "showers"
  | "tstorm"
  | "snow"
  | "sleet"
  | "wind"
  | "hot"
  | "cold";

const ICON_CODE_MAP: Array<[RegExp, WeatherIconCode]> = [
  [/^(tsra|tsra_sct|tsra_hi)/, "tstorm"],
  [/^(snow|blizzard|few_snow)/, "snow"],
  [/^(sleet|fzra|ip)/, "sleet"],
  [/^(rain_showers|rain_showers_hi|rain_sleet|rain_snow)/, "showers"],
  [/^rain/, "rain"],
  [/^(fog|haze)/, "fog"],
  [/^(wind|dust)/, "wind"],
  [/^hot/, "hot"],
  [/^cold/, "cold"],
  [/^(ovc|bkn)/, "overcast"],
  [/^(sct|few)/, "few"],
  [/^skc/, "clear"],
];

/** Parses an NWS icon URL (e.g. ".../icons/land/day/rain_showers,40?size=medium") into a
 * normalized WeatherIconCode. NWS icon paths may list two comma-separated conditions for a
 * transition period ("skc,40") — only the first (dominant) condition is used. */
export function nwsIconCode(iconUrl: string | null | undefined): WeatherIconCode | null {
  if (!iconUrl) return null;
  const match = /\/icons\/land\/(day|night)\/([^/?]+)/.exec(iconUrl);
  if (!match) return null;
  const raw = decodeURIComponent(match[2]!).split(",")[0]!.toLowerCase();
  for (const [pattern, code] of ICON_CODE_MAP) {
    if (pattern.test(raw)) return code;
  }
  return "clouds";
}

export interface NwsAlert {
  event: string;
  severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
  headline: string | null;
  description: string;
  effective: string;
  expires: string;
}

export interface WeatherHour {
  time: string; // ISO instant
  tempF: number | null;
  precipPct: number | null;
  iconCode: WeatherIconCode | null;
  shortForecast: string | null;
  windSpeed: string | null;
  windDirection: string | null;
  isDaytime: boolean;
}

export type WeatherSegmentName = "morning" | "midday" | "evening";

export interface WeatherSegment {
  segment: WeatherSegmentName;
  tempF: number | null;
  precipPct: number | null;
  iconCode: WeatherIconCode | null;
  shortForecast: string | null;
  isDaytime: boolean;
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
  iconCode: WeatherIconCode | null;
  hourly: WeatherHour[];
  segments: WeatherSegment[];
  alerts: NwsAlert[];
}

async function nwsFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`NWS request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

async function resolveForecastUrls(lat: number, lon: number): Promise<{ forecast: string; forecastHourly: string }> {
  const key = `${lat},${lon}`;
  const cached = forecastUrlCache.get(key);
  if (cached) return cached;

  const point = await nwsFetch<{ properties: { forecast: string; forecastHourly: string } }>(
    `${NWS_BASE}/points/${lat},${lon}`,
  );
  const urls = { forecast: point.properties.forecast, forecastHourly: point.properties.forecastHourly };
  forecastUrlCache.set(key, urls);
  return urls;
}

async function fetchPeriods(lat: number, lon: number): Promise<NwsForecastPeriod[]> {
  const { forecast: forecastUrl } = await resolveForecastUrls(lat, lon);
  const forecast = await nwsFetch<{ properties: { periods: NwsForecastPeriod[] } }>(forecastUrl);
  return forecast.properties.periods;
}

async function fetchHourlyPeriods(lat: number, lon: number): Promise<NwsForecastPeriod[]> {
  const { forecastHourly: hourlyUrl } = await resolveForecastUrls(lat, lon);
  const forecast = await nwsFetch<{ properties: { periods: NwsForecastPeriod[] } }>(hourlyUrl);
  return forecast.properties.periods;
}

async function fetchActiveAlerts(lat: number, lon: number): Promise<NwsAlert[]> {
  const alerts = await nwsFetch<{ features: Array<{ properties: NwsAlert }> }>(
    `${NWS_BASE}/alerts/active?point=${lat},${lon}`,
  );
  return alerts.features.map((f) => f.properties);
}

const SEGMENT_RANGES: Record<WeatherSegmentName, [number, number]> = {
  // [startHour, endHour) in athlete-local time.
  morning: [6, 11],
  midday: [11, 16],
  evening: [16, 21],
};

function toWeatherHour(period: NwsForecastPeriod): WeatherHour {
  return {
    time: period.startTime,
    tempF: period.temperature,
    precipPct: period.probabilityOfPrecipitation.value,
    iconCode: nwsIconCode(period.icon),
    shortForecast: period.shortForecast,
    windSpeed: period.windSpeed,
    windDirection: period.windDirection,
    isDaytime: period.isDaytime,
  };
}

/** Summarizes each SEGMENT_RANGES window from a day's local hours: temp/icon/conditions from
 * the window's middle hour (most representative of "what it feels like then"), precip as the
 * window's max (a runner cares about the worst case in the window, not the average). */
function deriveSegments(hours: WeatherHour[], timeZone: string): WeatherSegment[] {
  const segments: WeatherSegment[] = [];
  for (const [name, [start, end]] of Object.entries(SEGMENT_RANGES) as Array<
    [WeatherSegmentName, [number, number]]
  >) {
    const windowHours = hours.filter((h) => {
      const hour = hourInZone(new Date(h.time), timeZone);
      return hour >= start && hour < end;
    });
    if (windowHours.length === 0) continue;

    const midHour = windowHours[Math.floor(windowHours.length / 2)]!;
    const precipValues = windowHours.map((h) => h.precipPct).filter((v): v is number => v != null);

    segments.push({
      segment: name,
      tempF: midHour.tempF,
      precipPct: precipValues.length > 0 ? Math.max(...precipValues) : null,
      iconCode: midHour.iconCode,
      shortForecast: midHour.shortForecast,
      isDaytime: midHour.isDaytime,
    });
  }
  return segments;
}

/** Groups NWS's 12h day/night periods into one row per athlete-local calendar date, folding in
 * per-hour data (bucketed the same way) for the day's `hourly` list and derived `segments`, and
 * attaches any active alert whose effective/expires window overlaps that date. Periods are
 * bucketed by the local date of their `startTime` (not endTime), so an evening period that
 * crosses a UTC day boundary still lands on the day it starts. */
export function toDailyForecasts(
  periods: NwsForecastPeriod[],
  alerts: NwsAlert[],
  timeZone: string,
  hourlyPeriods: NwsForecastPeriod[] = [],
): DailyForecast[] {
  const buckets = new Map<string, { day?: NwsForecastPeriod; night?: NwsForecastPeriod }>();
  for (const period of periods) {
    const ymd = dateYmdInZone(new Date(period.startTime), timeZone);
    const bucket = buckets.get(ymd) ?? {};
    if (period.isDaytime) bucket.day ??= period;
    else bucket.night ??= period;
    buckets.set(ymd, bucket);
  }

  const hoursByDate = new Map<string, WeatherHour[]>();
  for (const period of hourlyPeriods) {
    const ymd = dateYmdInZone(new Date(period.startTime), timeZone);
    const list = hoursByDate.get(ymd) ?? [];
    list.push(toWeatherHour(period));
    hoursByDate.set(ymd, list);
  }
  for (const list of hoursByDate.values()) {
    list.sort((a, b) => a.time.localeCompare(b.time));
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { day, night }]) => {
      const dayStartIso = zonedLocalToIso(date, "00:00", timeZone);
      const dayEndIso = new Date(new Date(dayStartIso).getTime() + 24 * 60 * 60_000).toISOString();
      const dayAlerts = alerts.filter((a) => a.effective < dayEndIso && a.expires > dayStartIso);
      const hourly = hoursByDate.get(date) ?? [];

      return {
        date,
        highTempF: day?.temperature ?? null,
        lowTempF: night?.temperature ?? day?.temperature ?? null,
        shortForecast: day?.shortForecast ?? night?.shortForecast ?? null,
        precipProbabilityPct: day?.probabilityOfPrecipitation.value ?? night?.probabilityOfPrecipitation.value ?? null,
        windSpeed: day?.windSpeed ?? night?.windSpeed ?? null,
        windDirection: day?.windDirection ?? night?.windDirection ?? null,
        iconUrl: day?.icon ?? night?.icon ?? null,
        iconCode: nwsIconCode(day?.icon ?? night?.icon ?? null),
        hourly,
        segments: deriveSegments(hourly, timeZone),
        alerts: dayAlerts,
      };
    });
}

/** NWS daily forecasts for the next `days` calendar dates (athlete-local), enriched with hourly
 * data and derived morning/midday/evening segments. Throws on network/HTTP failure — callers
 * should catch and fall back, same as getPrimaryBusyPeriods. */
export async function getDailyForecasts(
  lat: number,
  lon: number,
  timeZone: string,
  days = 10,
): Promise<DailyForecast[]> {
  const [periods, hourlyPeriods, alerts] = await Promise.all([
    fetchPeriods(lat, lon),
    fetchHourlyPeriods(lat, lon),
    fetchActiveAlerts(lat, lon),
  ]);
  return toDailyForecasts(periods, alerts, timeZone, hourlyPeriods).slice(0, days);
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
