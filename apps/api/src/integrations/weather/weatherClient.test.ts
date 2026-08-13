import { describe, it, expect } from "vitest";
import { toDailyForecasts, type NwsForecastPeriod, type NwsAlert } from "./weatherClient.js";

function makePeriod(overrides: Partial<NwsForecastPeriod> = {}): NwsForecastPeriod {
  return {
    startTime: "2026-08-12T06:00:00-04:00",
    endTime: "2026-08-12T18:00:00-04:00",
    isDaytime: true,
    temperature: 80,
    temperatureUnit: "F",
    probabilityOfPrecipitation: { value: 20 },
    windSpeed: "5 to 10 mph",
    windDirection: "NW",
    shortForecast: "Sunny",
    icon: "https://api.weather.gov/icons/land/day/skc?size=medium",
    ...overrides,
  };
}

describe("toDailyForecasts", () => {
  it("pairs a daytime period with its following overnight period on the same local date", () => {
    const periods = [
      makePeriod({ startTime: "2026-08-12T06:00:00-04:00", isDaytime: true, temperature: 85 }),
      // Overnight period starts the evening of Aug 12 local time and crosses midnight UTC.
      makePeriod({
        startTime: "2026-08-12T20:00:00-04:00",
        endTime: "2026-08-13T06:00:00-04:00",
        isDaytime: false,
        temperature: 62,
        shortForecast: "Clear",
      }),
    ];
    const result = toDailyForecasts(periods, [], "America/New_York");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ date: "2026-08-12", highTempF: 85, lowTempF: 62 });
  });

  it("buckets an evening period by its local start date, not its UTC date", () => {
    // 8pm EDT on Aug 12 is already Aug 13 in UTC — must still bucket to Aug 12 local.
    const periods = [makePeriod({ startTime: "2026-08-12T20:00:00-04:00", isDaytime: false, temperature: 60 })];
    const result = toDailyForecasts(periods, [], "America/New_York");
    expect(result[0]?.date).toBe("2026-08-12");
  });

  it("falls back to the daytime period's temperature as the low when no overnight period exists", () => {
    const periods = [makePeriod({ startTime: "2026-08-18T06:00:00-04:00", isDaytime: true, temperature: 70 })];
    const result = toDailyForecasts(periods, [], "America/New_York");
    expect(result[0]).toMatchObject({ highTempF: 70, lowTempF: 70 });
  });

  it("attaches alerts whose effective/expires window overlaps the date", () => {
    const periods = [makePeriod({ startTime: "2026-08-12T06:00:00-04:00" })];
    const alert: NwsAlert = {
      event: "Heat Advisory",
      severity: "Moderate",
      headline: "Heat Advisory in effect",
      description: "...",
      effective: "2026-08-12T12:00:00-04:00",
      expires: "2026-08-12T20:00:00-04:00",
    };
    const result = toDailyForecasts(periods, [alert], "America/New_York");
    expect(result[0]?.alerts).toEqual([alert]);
  });

  it("does not attach an alert that expired before the date starts", () => {
    const periods = [makePeriod({ startTime: "2026-08-12T06:00:00-04:00" })];
    const alert: NwsAlert = {
      event: "Heat Advisory",
      severity: "Moderate",
      headline: null,
      description: "...",
      effective: "2026-08-10T12:00:00-04:00",
      expires: "2026-08-11T12:00:00-04:00",
    };
    const result = toDailyForecasts(periods, [alert], "America/New_York");
    expect(result[0]?.alerts).toEqual([]);
  });

  it("sorts results by date ascending regardless of input order", () => {
    const periods = [
      makePeriod({ startTime: "2026-08-14T06:00:00-04:00" }),
      makePeriod({ startTime: "2026-08-12T06:00:00-04:00" }),
      makePeriod({ startTime: "2026-08-13T06:00:00-04:00" }),
    ];
    const result = toDailyForecasts(periods, [], "America/New_York");
    expect(result.map((d) => d.date)).toEqual(["2026-08-12", "2026-08-13", "2026-08-14"]);
  });
});
