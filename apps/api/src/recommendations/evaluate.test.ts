import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluate.js";
import type { RuleContext, PlannedRunRow } from "./types.js";
import type { RecoverySnapshot } from "@run-far/shared";

const baseSnapshot: RecoverySnapshot = {
  date: "2026-08-11",
  recoveryScore: 70,
  hrvRmssdMs: 60,
  hrvBaselineMs: 60,
  hrvBaselineSd: 5,
  restingHr: 50,
  restingHrBaseline: 50,
  sleepDebtMinToday: 0,
  cycleStrainAvg7d: 10,
  cycleLoadSum7d: 1500,
  cycleStrainToday: 10,
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

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    snapshot: baseSnapshot,
    upcoming: [],
    busyPeriods: [],
    ...overrides,
  };
}

describe("red-recovery-hard-session", () => {
  it("downgrades a hard session when recovery is red and next run is hard", () => {
    const run = makeRun({ runType: "tempo" });
    const result = evaluate(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 25 },
        upcoming: [run],
      }),
    );
    expect(result.primary?.ruleId).toBe("red-recovery-hard-session");
    expect(result.primary?.severity).toBe("red");
    expect(result.primary?.proposedChanges).toEqual([
      { plannedRunId: run.id, field: "runType", from: "tempo", to: "easy" },
      { plannedRunId: run.id, field: "targetPaceSPerKm", from: run.targetPaceSPerKm, to: null },
    ]);
  });

  it("does not fire when recovery is red but next run is already easy", () => {
    const run = makeRun({ runType: "easy" });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 25 }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).not.toBe("red-recovery-hard-session");
  });

  it("does not fire when recovery score is null", () => {
    const run = makeRun({ runType: "tempo" });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: null }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).not.toBe("red-recovery-hard-session");
  });
});

describe("yellow-recovery-hard-session", () => {
  it("trims volume by the configured percentage in the yellow zone", () => {
    const run = makeRun({ runType: "long", durationMin: 100, distanceM: 20000 });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 50 }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).toBe("yellow-recovery-hard-session");
    expect(result.primary?.severity).toBe("yellow");
    expect(result.primary?.proposedChanges).toEqual([
      { plannedRunId: run.id, field: "durationMin", from: 100, to: 80 },
      { plannedRunId: run.id, field: "distanceM", from: 20000, to: 16000 },
    ]);
  });

  it("does not fire in the red zone (red rule takes priority)", () => {
    const run = makeRun({ runType: "tempo" });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 20 }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).toBe("red-recovery-hard-session");
  });
});

describe("hrv-suppressed", () => {
  it("fires when HRV has been suppressed for the minimum consecutive days", () => {
    const result = evaluate(
      makeContext({
        snapshot: {
          ...baseSnapshot,
          hrvRmssdMs: 50,
          hrvBaselineMs: 60,
          hrvBaselineSd: 5,
          hrvSuppressedConsecutiveDays: 2,
        },
      }),
    );
    expect(result.primary?.ruleId).toBe("hrv-suppressed");
    expect(result.primary?.severity).toBe("yellow");
  });

  it("does not fire with only a single suppressed day", () => {
    const result = evaluate(
      makeContext({
        snapshot: {
          ...baseSnapshot,
          hrvRmssdMs: 50,
          hrvBaselineMs: 60,
          hrvBaselineSd: 5,
          hrvSuppressedConsecutiveDays: 1,
        },
      }),
    );
    expect(result.primary).toBeNull();
  });
});

describe("sleep-debt", () => {
  it("shifts the next hard session a day later when debt exceeds the threshold", () => {
    const run = makeRun({ runType: "interval", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, sleepDebtMinToday: 200 }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).toBe("sleep-debt");
    expect(result.primary?.proposedChanges).toEqual([
      {
        plannedRunId: run.id,
        field: "scheduledAt",
        from: "2026-08-12T14:00:00.000Z",
        to: "2026-08-13T14:00:00.000Z",
      },
    ]);
  });

  it("does not fire below the debt threshold", () => {
    const run = makeRun({ runType: "interval" });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, sleepDebtMinToday: 50 }, upcoming: [run] }),
    );
    expect(result.primary).toBeNull();
  });
});

describe("acwr-spike", () => {
  it("fires as an info-level note when ACWR exceeds the spike threshold", () => {
    const result = evaluate(makeContext({ snapshot: { ...baseSnapshot, acwr: 1.8 } }));
    expect(result.primary?.ruleId).toBe("acwr-spike");
    expect(result.primary?.severity).toBe("info");
    expect(result.primary?.proposedChanges).toEqual([]);
  });

  it("does not fire below the threshold", () => {
    const result = evaluate(makeContext({ snapshot: { ...baseSnapshot, acwr: 1.4 } }));
    expect(result.primary).toBeNull();
  });
});

describe("green-recovery-easy-day", () => {
  it("suggests pulling a later hard run forward when recovery is high and today is easy", () => {
    const today = makeRun({ runType: "easy", scheduledAt: new Date("2026-08-11T14:00:00Z") });
    const laterHard = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-14T14:00:00Z") });
    const result = evaluate(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 90 },
        upcoming: [today, laterHard],
      }),
    );
    expect(result.primary?.ruleId).toBe("green-recovery-easy-day");
    expect(result.primary?.proposedChanges).toEqual([
      {
        plannedRunId: laterHard.id,
        field: "scheduledAt",
        from: laterHard.scheduledAt.toISOString(),
        to: today.scheduledAt.toISOString(),
      },
    ]);
  });

  it("does not fire when today is already a hard day", () => {
    const today = makeRun({ runType: "tempo" });
    const result = evaluate(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 90 }, upcoming: [today] }),
    );
    expect(result.primary?.ruleId).not.toBe("green-recovery-easy-day");
  });
});

describe("calendar-conflict", () => {
  it("proposes the nearest open slot when the next run overlaps a busy period", () => {
    const run = makeRun({
      scheduledAt: new Date("2026-08-12T14:00:00Z"),
      durationMin: 60,
    });
    const busy = { start: new Date("2026-08-12T14:00:00Z"), end: new Date("2026-08-12T15:00:00Z") };
    const result = evaluate(makeContext({ upcoming: [run], busyPeriods: [busy] }));
    expect(result.primary?.ruleId).toBe("calendar-conflict");
    expect(result.primary?.proposedChanges[0]?.plannedRunId).toBe(run.id);
    expect(result.primary?.proposedChanges[0]?.field).toBe("scheduledAt");
  });

  it("does not fire when there is no overlap", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const busy = { start: new Date("2026-08-12T16:00:00Z"), end: new Date("2026-08-12T17:00:00Z") };
    const result = evaluate(makeContext({ upcoming: [run], busyPeriods: [busy] }));
    expect(result.primary).toBeNull();
  });

  it("flags every conflicting run in the week, not just the next one", () => {
    const runA = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const runB = makeRun({ scheduledAt: new Date("2026-08-14T14:00:00Z"), durationMin: 60 });
    const clean = makeRun({ scheduledAt: new Date("2026-08-13T14:00:00Z"), durationMin: 60 });
    const busyA = { start: new Date("2026-08-12T14:00:00Z"), end: new Date("2026-08-12T15:00:00Z") };
    const busyB = { start: new Date("2026-08-14T14:00:00Z"), end: new Date("2026-08-14T15:00:00Z") };
    const result = evaluate(
      makeContext({ upcoming: [runA, clean, runB], busyPeriods: [busyA, busyB] }),
    );
    expect(result.primary?.ruleId).toBe("calendar-conflict");
    expect(result.primary?.summary).toContain("2 runs");
    const touchedRunIds = result.primary?.proposedChanges.map((c) => c.plannedRunId);
    expect(touchedRunIds).toEqual([runA.id, runB.id]);
  });
});

describe("evaluate priority ordering", () => {
  it("ranks red above yellow and surfaces info rules as secondary", () => {
    const run = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const busy = { start: new Date("2026-08-12T14:00:00Z"), end: new Date("2026-08-12T15:00:00Z") };
    const result = evaluate(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 25, acwr: 1.8 },
        upcoming: [run],
        busyPeriods: [busy],
      }),
    );
    expect(result.primary?.severity).toBe("red");
    expect(result.secondary.map((r) => r.ruleId)).toEqual(
      expect.arrayContaining(["acwr-spike", "calendar-conflict"]),
    );
  });

  it("returns no primary when nothing fires", () => {
    const run = makeRun({ runType: "easy" });
    const result = evaluate(makeContext({ upcoming: [run] }));
    expect(result.primary).toBeNull();
    expect(result.secondary).toEqual([]);
  });
});
