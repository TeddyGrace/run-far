import { describe, it, expect } from "vitest";
import { weatherAdvisory } from "./weatherAdvisory.js";
import type { RuleContext, PlannedRunRow } from "../types.js";
import type { RecoverySnapshot } from "@run-far/shared";
import type { DailyForecast, WeatherHour } from "../../integrations/weather/weatherClient.js";
import { DEFAULT_RULE_THRESHOLDS } from "../config.js";

const baseSnapshot: RecoverySnapshot = {
  date: "2026-08-12",
  provider: "whoop",
  hrvMetric: "rmssd",
  recoveryScoreSource: "provider",
  recoveryScore: 70,
  hrvRmssdMs: 60,
  hrvBaselineMs: 60,
  hrvBaselineSd: 5,
  restingHr: 50,
  restingHrBaseline: 50,
  sleepDebtMinToday: 0,
  cycleStrainAvg7d: 10,
  cycleLoadSum7d: 1500,
  cyclesCounted7d: 7,
  acuteTss7d: 100,
  chronicTss28d: 400,
  acwr: 1,
  runDistanceMThisWeek: null,
  runDistanceMPerWeekThisMonth: null,
  hrvSuppressedConsecutiveDays: 0,
};

let runCounter = 0;
function makeRun(overrides: Partial<PlannedRunRow> = {}): PlannedRunRow {
  runCounter += 1;
  return {
    id: `run-${runCounter}`,
    userId: "user-1",
    planId: null,
    scheduledAt: new Date("2026-08-12T14:00:00Z"),
    durationMin: 60,
    distanceM: 10000,
    runType: "easy",
    targetPaceSPerKm: 300,
    plannedTss: 50,
    description: null,
    structure: null,
    status: "planned",
    gcalEventId: null,
    gcalEtag: null,
    origin: "manual",
    actualWorkoutId: null,
    matchSource: null,
    reconciledAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function makeForecast(overrides: Partial<DailyForecast> = {}): DailyForecast {
  return {
    date: "2026-08-12",
    highTempF: 75,
    lowTempF: 55,
    shortForecast: "Sunny",
    precipProbabilityPct: 10,
    windSpeed: "5 mph",
    windDirection: "NW",
    iconUrl: null,
    iconCode: null,
    hourly: [],
    segments: [],
    alerts: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    snapshot: baseSnapshot,
    upcoming: [],
    busyPeriods: [],
    weatherForecast: [],
    // The shipped defaults, so these fixtures keep asserting against the calibration the engine
    // actually ships with. A test that needs a differently-tuned athlete overrides this field.
    thresholds: DEFAULT_RULE_THRESHOLDS,
    timeZone: "America/New_York",
    now: new Date("2026-08-12T12:00:00Z"),
    ...overrides,
  };
}

/**
 * The hourly forecast the rule reasons about when it proposes a time.
 *
 * `2026-08-12` is a Wednesday in EDT, so -04:00 is New York's offset throughout and a local
 * hour reads straight off the string. `hot` lists the local hours that are above the heat
 * threshold; everything else is comfortable.
 */
function makeHours(
  date: string,
  opts: { hot?: number[]; wet?: number[] } = {},
): WeatherHour[] {
  const hot = new Set(opts.hot ?? []);
  const wet = new Set(opts.wet ?? []);
  return Array.from({ length: 24 }, (_, hour) => ({
    time: `${date}T${String(hour).padStart(2, "0")}:00:00-04:00`,
    tempF: hot.has(hour) ? 94 : 68,
    precipPct: wet.has(hour) ? 80 : 5,
    iconCode: null,
    shortForecast: hot.has(hour) ? "Hot" : "Sunny",
    windSpeed: "5 mph",
    windDirection: "NW",
    isDaytime: hour >= 7 && hour <= 19,
  }));
}

/** A run at a given local hour on the fixture day. */
function runAtLocalHour(hour: number, overrides: Partial<PlannedRunRow> = {}): PlannedRunRow {
  return makeRun({
    scheduledAt: new Date(`2026-08-12T${String(hour).padStart(2, "0")}:00:00-04:00`),
    durationMin: 60,
    ...overrides,
  });
}

/** Local hour of an ISO instant, in the fixture timezone. */
function localHourOf(iso: string): number {
  return Number(
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "America/New_York",
    }).slice(0, 2),
  );
}

describe("weather-advisory", () => {
  it("does not fire when no forecast data is available", () => {
    const run = makeRun();
    const result = weatherAdvisory(makeContext({ upcoming: [run], weatherForecast: [] }));
    expect(result).toBeNull();
  });

  it("fires yellow when the forecast high exceeds the heat threshold", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const result = weatherAdvisory(
      makeContext({ upcoming: [run], weatherForecast: [makeForecast({ highTempF: 92 })] }),
    );
    expect(result?.ruleId).toBe("weather-advisory");
    expect(result?.severity).toBe("yellow");
  });

  it("fires yellow when precipitation probability exceeds the threshold", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const result = weatherAdvisory(
      makeContext({ upcoming: [run], weatherForecast: [makeForecast({ precipProbabilityPct: 75 })] }),
    );
    expect(result?.ruleId).toBe("weather-advisory");
    expect(result?.severity).toBe("yellow");
  });

  it("fires red when an active alert's window overlaps the run", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const forecast = makeForecast({
      alerts: [
        {
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: null,
          description: "...",
          effective: "2026-08-12T13:30:00Z",
          expires: "2026-08-12T15:00:00Z",
        },
      ],
    });
    const result = weatherAdvisory(makeContext({ upcoming: [run], weatherForecast: [forecast] }));
    expect(result?.ruleId).toBe("weather-advisory");
    expect(result?.severity).toBe("red");
  });

  it("does not fire when an alert exists but its window doesn't overlap the run", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const forecast = makeForecast({
      alerts: [
        {
          event: "Severe Thunderstorm Warning",
          severity: "Severe",
          headline: null,
          description: "...",
          effective: "2026-08-12T02:00:00Z",
          expires: "2026-08-12T04:00:00Z",
        },
      ],
    });
    const result = weatherAdvisory(makeContext({ upcoming: [run], weatherForecast: [forecast] }));
    expect(result).toBeNull();
  });

  it("does not fire for a rest run even under a heat advisory", () => {
    const run = makeRun({ runType: "rest", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const result = weatherAdvisory(
      makeContext({ upcoming: [run], weatherForecast: [makeForecast({ highTempF: 95 })] }),
    );
    expect(result).toBeNull();
  });

  it("does not fire when conditions are mild", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const result = weatherAdvisory(makeContext({ upcoming: [run], weatherForecast: [makeForecast()] }));
    expect(result).toBeNull();
  });

  describe("proposing a better time", () => {
    // Midday and afternoon are brutal; early morning and evening are fine.
    const HOT_AFTERNOON = { hot: [11, 12, 13, 14, 15, 16, 17] };
    const morningNow = new Date("2026-08-12T09:00:00Z"); // 5am local, before every candidate

    it("moves a run out of the heat to the nearest hour that is actually fine", () => {
      const run = runAtLocalHour(12);
      const result = weatherAdvisory(
        makeContext({
          upcoming: [run],
          now: morningNow,
          weatherForecast: [makeForecast({ hourly: makeHours("2026-08-12", HOT_AFTERNOON) })],
        }),
      );

      expect(result?.proposedChanges).toHaveLength(1);
      const change = result!.proposedChanges[0]!;
      expect(change.field).toBe("scheduledAt");
      expect(change.plannedRunId).toBe(run.id);
      // 10am: the *nearest* hour whose whole run window clears the heat, two hours off rather
      // than six. Deliberately not 5am — the coolest hour of a hot day is always dawn, and a
      // rule that always answers dawn is one the athlete stops reading.
      expect(localHourOf(change.to as string)).toBe(10);
    });

    it("judges heat by the hours the run actually covers, not the day's high", () => {
      // The afternoon hits 94°F, but this run is at 6am. Flagging it off the daily high — which
      // is what the day-summary path does — was advice about a run the athlete isn't doing.
      const result = weatherAdvisory(
        makeContext({
          upcoming: [runAtLocalHour(6)],
          now: new Date("2026-08-12T04:00:00Z"),
          weatherForecast: [
            makeForecast({ highTempF: 94, hourly: makeHours("2026-08-12", HOT_AFTERNOON) }),
          ],
        }),
      );

      expect(result).toBeNull();
    });

    it("stays advisory when the forecast has no hourly detail", () => {
      const result = weatherAdvisory(
        makeContext({
          upcoming: [runAtLocalHour(12)],
          now: morningNow,
          weatherForecast: [makeForecast({ highTempF: 94, hourly: [] })],
        }),
      );

      // Picking an hour off a daily high would be guessing at which hour is better.
      expect(result?.proposedChanges).toEqual([]);
      expect(result?.reason).toContain("plan for heat");
    });

    it("will not move a run into a calendar commitment", () => {
      const run = runAtLocalHour(12);
      const result = weatherAdvisory(
        makeContext({
          upcoming: [run],
          now: morningNow,
          // The 6pm slot it would otherwise pick is taken.
          busyPeriods: [
            {
              start: new Date("2026-08-12T17:30:00-04:00"),
              end: new Date("2026-08-12T19:30:00-04:00"),
            },
          ],
          weatherForecast: [makeForecast({ hourly: makeHours("2026-08-12", HOT_AFTERNOON) })],
        }),
      );

      // Otherwise this rule proposes a slot the calendar-conflict rule would immediately object
      // to — the engine arguing with itself.
      expect(localHourOf(result!.proposedChanges[0]!.to as string)).not.toBe(18);
    });

    it("will not stack the run on top of another run that day", () => {
      const run = runAtLocalHour(12);
      const evening = runAtLocalHour(18, { runType: "easy" });
      const result = weatherAdvisory(
        makeContext({
          upcoming: [run, evening],
          now: morningNow,
          weatherForecast: [makeForecast({ hourly: makeHours("2026-08-12", HOT_AFTERNOON) })],
        }),
      );

      expect(localHourOf(result!.proposedChanges[0]!.to as string)).not.toBe(18);
    });

    it("never proposes a time already past", () => {
      const result = weatherAdvisory(
        makeContext({
          upcoming: [runAtLocalHour(20)],
          // 7pm local: the cool morning hours are gone.
          now: new Date("2026-08-12T23:00:00Z"),
          weatherForecast: [
            makeForecast({ hourly: makeHours("2026-08-12", { hot: [19, 20, 21] }) }),
          ],
        }),
      );

      const to = result?.proposedChanges[0]?.to;
      if (to) expect(new Date(to as string).getTime()).toBeGreaterThan(Date.parse("2026-08-12T23:00:00Z"));
    });

    it("stays advisory when no hour that day is any better", () => {
      const result = weatherAdvisory(
        makeContext({
          upcoming: [runAtLocalHour(12)],
          now: morningNow,
          weatherForecast: [
            makeForecast({
              hourly: makeHours("2026-08-12", { hot: Array.from({ length: 24 }, (_, i) => i) }),
            }),
          ],
        }),
      );

      // A card proposing nothing is the honest answer to a day that is hot all day.
      expect(result?.proposedChanges).toEqual([]);
    });

    it("moves a run out of the rain the same way it moves one out of the heat", () => {
      const result = weatherAdvisory(
        makeContext({
          upcoming: [runAtLocalHour(12)],
          now: morningNow,
          weatherForecast: [
            makeForecast({ hourly: makeHours("2026-08-12", { wet: [10, 11, 12, 13, 14, 15] }) }),
          ],
        }),
      );

      expect(localHourOf(result!.proposedChanges[0]!.to as string)).toBe(9);
    });

    it("proposes a change to at most one run", () => {
      const result = weatherAdvisory(
        makeContext({
          upcoming: [runAtLocalHour(12), runAtLocalHour(13)],
          now: morningNow,
          weatherForecast: [makeForecast({ hourly: makeHours("2026-08-12", HOT_AFTERNOON) })],
        }),
      );

      // Arbitration lets a card own one run anyway, and moving three sessions off a forecast
      // would be a bigger decision than a forecast earns.
      expect(result?.proposedChanges).toHaveLength(1);
    });
  });
});
