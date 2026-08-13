import { z } from "zod";

export const nwsAlertSchema = z.object({
  event: z.string(),
  severity: z.enum(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]),
  headline: z.string().nullable(),
  description: z.string(),
  effective: z.string(),
  expires: z.string(),
});
export type NwsAlert = z.infer<typeof nwsAlertSchema>;

export const weatherIconCodeSchema = z.enum([
  "clear",
  "few",
  "clouds",
  "overcast",
  "fog",
  "rain",
  "showers",
  "tstorm",
  "snow",
  "sleet",
  "wind",
  "hot",
  "cold",
]);
export type WeatherIconCode = z.infer<typeof weatherIconCodeSchema>;

export const weatherHourSchema = z.object({
  time: z.string(),
  tempF: z.number().nullable(),
  precipPct: z.number().nullable(),
  iconCode: weatherIconCodeSchema.nullable(),
  shortForecast: z.string().nullable(),
  windSpeed: z.string().nullable(),
  windDirection: z.string().nullable(),
  isDaytime: z.boolean(),
});
export type WeatherHour = z.infer<typeof weatherHourSchema>;

export const weatherSegmentSchema = z.object({
  segment: z.enum(["morning", "midday", "evening"]),
  tempF: z.number().nullable(),
  precipPct: z.number().nullable(),
  iconCode: weatherIconCodeSchema.nullable(),
  shortForecast: z.string().nullable(),
  isDaytime: z.boolean(),
});
export type WeatherSegment = z.infer<typeof weatherSegmentSchema>;

export const weatherForecastSchema = z.object({
  id: z.string().uuid(),
  date: z.string(),
  highTempF: z.number().nullable(),
  lowTempF: z.number().nullable(),
  shortForecast: z.string().nullable(),
  precipProbabilityPct: z.number().nullable(),
  windSpeed: z.string().nullable(),
  windDirection: z.string().nullable(),
  iconUrl: z.string().nullable(),
  iconCode: weatherIconCodeSchema.nullable(),
  hourly: z.array(weatherHourSchema),
  segments: z.array(weatherSegmentSchema),
  alerts: z.array(nwsAlertSchema),
  fetchedAt: z.string(),
});
export type WeatherForecast = z.infer<typeof weatherForecastSchema>;

export interface WeatherForecastResponse {
  // Whether the athlete has a location set (per-user or env fallback) — lets the frontend
  // tell "no location configured" apart from "location set, no data pulled yet".
  configured: boolean;
  forecasts: WeatherForecast[];
}
