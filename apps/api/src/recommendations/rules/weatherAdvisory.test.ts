import { describe, it, expect } from "vitest";
import { weatherAdvisory } from "./weatherAdvisory.js";
import type { RuleContext, PlannedRunRow } from "../types.js";
import type { RecoverySnapshot } from "@run-far/shared";
import type { DailyForecast } from "../../integrations/weather/weatherClient.js";

const baseSnapshot: RecoverySnapshot = {
  date: "2026-08-12",
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
    timeZone: "America/New_York",
    ...overrides,
  };
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
});
