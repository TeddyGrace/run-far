import { describe, expect, it } from "vitest";
import type { RecoverySnapshot } from "@run-far/shared";

import { hardDayDensity } from "./hardDayDensity.js";
import { DEFAULT_RULE_THRESHOLDS } from "../config.js";
import type { PlannedRunRow, RuleContext } from "../types.js";

/**
 * The structural rule.
 *
 * What makes it different from every other rule here is that it can fire on a perfectly healthy
 * athlete — it reads the plan, not the body. So the cases that matter are the ones about the
 * *shape* of the schedule: what breaks a streak, which session it picks to change, and that it
 * doesn't start objecting to days that have already happened.
 */
const TZ = "America/New_York";
const NOW = new Date("2025-06-11T09:00:00-04:00"); // Wednesday

const baseSnapshot: RecoverySnapshot = {
  date: "2025-06-11",
  recoveryScore: 80,
  hrvRmssdMs: 70,
  hrvBaselineMs: 70,
  hrvBaselineSd: 5,
  restingHr: 50,
  restingHrBaseline: 50,
  sleepDebtMinToday: 0,
  cycleStrainAvg7d: 10,
  cycleLoadSum7d: 1500,
  cyclesCounted7d: 7,
  acwr: 1,
  runDistanceMThisWeek: null,
  runDistanceMPerWeekThisMonth: null,
  hrvSuppressedConsecutiveDays: 0,
};

let counter = 0;
function run(localDate: string, runType: string, hour = 7): PlannedRunRow {
  counter += 1;
  return {
    id: `run-${counter}`,
    userId: "user-1",
    planId: null,
    scheduledAt: new Date(`${localDate}T${String(hour).padStart(2, "0")}:00:00-04:00`),
    durationMin: 60,
    distanceM: 10_000,
    runType: runType as PlannedRunRow["runType"],
    targetPaceSPerKm: 300,
    plannedTss: 50,
    description: null,
    structure: null,
    status: "planned",
    gcalEventId: null,
    gcalEtag: null,
    origin: "imported",
    actualWorkoutId: null,
    matchSource: null,
    reconciledAt: null,
    createdAt: new Date("2025-06-01T00:00:00Z"),
    updatedAt: new Date("2025-06-01T00:00:00Z"),
  };
}

function ctx(upcoming: PlannedRunRow[], overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    snapshot: baseSnapshot,
    upcoming,
    busyPeriods: [],
    weatherForecast: [],
    timeZone: TZ,
    now: NOW,
    thresholds: DEFAULT_RULE_THRESHOLDS,
    ...overrides,
  };
}

describe("hardDayDensity", () => {
  it("fires on three straight quality days and proposes easing the middle one", () => {
    const wed = run("2025-06-11", "tempo");
    const thu = run("2025-06-12", "interval");
    const fri = run("2025-06-13", "long");

    const out = hardDayDensity(ctx([wed, thu, fri]));

    expect(out?.ruleId).toBe("hard-day-density");
    // The middle day, not either end: easing the first wastes the freshest day and easing the
    // last just shortens the block without separating anything.
    expect(out?.proposedChanges).toEqual([
      { plannedRunId: thu.id, field: "runType", from: "interval", to: "easy" },
      { plannedRunId: thu.id, field: "targetPaceSPerKm", from: 300, to: null },
    ]);
  });

  it("does not fire at the athlete's allowed limit", () => {
    expect(hardDayDensity(ctx([run("2025-06-11", "tempo"), run("2025-06-12", "long")]))).toBeNull();
  });

  it("respects an athlete who allows more", () => {
    const days = [
      run("2025-06-11", "tempo"),
      run("2025-06-12", "interval"),
      run("2025-06-13", "long"),
    ];

    expect(hardDayDensity(ctx(days))).not.toBeNull();
    expect(
      hardDayDensity(
        ctx(days, { thresholds: { ...DEFAULT_RULE_THRESHOLDS, maxConsecutiveHardDays: 3 } }),
      ),
    ).toBeNull();
  });

  it("treats an easy day between hard days as breaking the streak", () => {
    const out = hardDayDensity(
      ctx([
        run("2025-06-11", "tempo"),
        run("2025-06-12", "easy"),
        run("2025-06-13", "interval"),
        run("2025-06-14", "easy"),
        run("2025-06-15", "long"),
      ]),
    );

    // Three quality sessions in five days, but never two adjacent — this is a well-shaped week
    // and flagging it would train the athlete to ignore the card.
    expect(out).toBeNull();
  });

  it("treats a day with nothing scheduled as breaking the streak", () => {
    const out = hardDayDensity(
      ctx([run("2025-06-11", "tempo"), run("2025-06-12", "long"), run("2025-06-14", "interval")]),
    );
    expect(out).toBeNull();
  });

  it("treats an explicit rest day as breaking the streak", () => {
    const out = hardDayDensity(
      ctx([
        run("2025-06-11", "tempo"),
        run("2025-06-12", "long"),
        run("2025-06-13", "rest"),
        run("2025-06-14", "interval"),
      ]),
    );
    expect(out).toBeNull();
  });

  it("counts a day as hard when quality is scheduled alongside an easy run", () => {
    const out = hardDayDensity(
      ctx([
        run("2025-06-11", "tempo"),
        run("2025-06-12", "easy", 6),
        run("2025-06-12", "interval", 18),
        run("2025-06-13", "long"),
      ]),
    );

    // A double day with a tempo in it is not an easy day, whatever else is on it.
    expect(out).not.toBeNull();
    expect(out?.summary).toContain("3 hard days in a row");
  });

  it("ignores days already past", () => {
    // A streak that ended yesterday is not something the athlete can act on.
    const out = hardDayDensity(
      ctx([run("2025-06-09", "tempo"), run("2025-06-10", "interval"), run("2025-06-11", "long")]),
    );
    expect(out).toBeNull();
  });

  it("flags the first overlong streak when the window holds more than one", () => {
    const out = hardDayDensity(
      ctx([
        run("2025-06-11", "tempo"),
        run("2025-06-12", "interval"),
        run("2025-06-13", "long"),
        run("2025-06-15", "tempo"),
        run("2025-06-16", "interval"),
        run("2025-06-17", "long"),
      ]),
    );

    expect(out?.summary).toContain("Thursday");
  });

  it("picks the earlier middle of an even-length streak", () => {
    const runs = [
      run("2025-06-11", "tempo"),
      run("2025-06-12", "interval"),
      run("2025-06-13", "long"),
      run("2025-06-14", "tempo"),
    ];

    const out = hardDayDensity(
      ctx(runs, { thresholds: { ...DEFAULT_RULE_THRESHOLDS, maxConsecutiveHardDays: 3 } }),
    );
    // Four in a row, allowance three: the easy day should land sooner rather than later.
    expect(out?.proposedChanges[0]?.plannedRunId).toBe(runs[1]!.id);
  });

  it("says out loud that nothing physiological has fired", () => {
    const out = hardDayDensity(
      ctx([
        run("2025-06-11", "tempo"),
        run("2025-06-12", "interval"),
        run("2025-06-13", "long"),
      ]),
    );
    // The athlete is green with normal HRV — without this the card reads as the engine
    // reacting to data it isn't actually looking at.
    expect(out?.reason).toContain("shape of the week");
  });

  it("returns nothing for an empty schedule", () => {
    expect(hardDayDensity(ctx([]))).toBeNull();
  });
});
