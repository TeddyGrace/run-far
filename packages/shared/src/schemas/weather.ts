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
