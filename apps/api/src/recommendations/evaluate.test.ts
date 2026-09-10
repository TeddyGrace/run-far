import { describe, it, expect } from "vitest";
import { evaluate, rankOutputs } from "./evaluate.js";
import type { RuleContext, PlannedRunRow, RuleOutput } from "./types.js";
import type { RecommendationSource } from "./sources/types.js";
import type { RecoverySnapshot } from "@run-far/shared";
import type { DailyForecast } from "../integrations/weather/weatherClient.js";
import { dateYmdInZone } from "../lib/zonedTime.js";
import { DEFAULT_RULE_THRESHOLDS } from "./config.js";

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
    actualWorkoutId: null,
    matchSource: null,
    reconciledAt: null,
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
    weatherForecast: [],
    // The shipped defaults, so these fixtures keep asserting against the calibration the engine
    // actually ships with. A test that needs a differently-tuned athlete overrides this field.
    thresholds: DEFAULT_RULE_THRESHOLDS,
    timeZone: "America/New_York",
    // 08:00 America/New_York on Aug 12 — the local day makeRun() schedules onto by default,
    // so the recovery-driven rules (which now only touch *today's* run) see one.
    now: new Date("2026-08-12T12:00:00Z"),
    ...overrides,
  };
}

/** evaluate() returns a ranked array; these tests were written against the primary/secondary
 * split the dashboard renders, which is just index 0 and the rest. */
function evaluated(ctx: RuleContext) {
  const fired = evaluate(ctx);
  return { primary: fired[0] ?? null, secondary: fired.slice(1), all: fired };
}

/**
 * The payoff of per-athlete calibration: identical physiology, different verdicts.
 *
 * Every other test in this file runs against DEFAULT_RULE_THRESHOLDS, so without these the
 * engine could quietly ignore the athlete's settings and the whole suite would still pass.
 */
describe("per-athlete thresholds", () => {
  const tuned = (overrides: Partial<typeof DEFAULT_RULE_THRESHOLDS>) => ({
    ...DEFAULT_RULE_THRESHOLDS,
    ...overrides,
  });

  it("does not call a day red for an athlete whose red line is lower", () => {
    const run = makeRun({ runType: "tempo" });
    const snapshot = { ...baseSnapshot, recoveryScore: 30 };

    // 30% is red under the shipped default of 33...
    expect(evaluated(makeContext({ snapshot, upcoming: [run] })).primary?.ruleId).toBe(
      "red-recovery-hard-session",
    );

    // ...and merely yellow for an athlete who runs low and has said so.
    const result = evaluated(
      makeContext({ snapshot, upcoming: [run], thresholds: tuned({ recoveryRedMax: 20 }) }),
    );
    expect(result.primary?.ruleId).toBe("yellow-recovery-hard-session");
  });

  it("quotes the athlete's own red line back to them, not the default", () => {
    const result = evaluated(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 18 },
        upcoming: [makeRun({ runType: "tempo" })],
        thresholds: tuned({ recoveryRedMax: 20 }),
      }),
    );
    // A card explaining itself with a threshold the athlete didn't set reads as a bug in the
    // engine rather than a setting they chose.
    expect(result.primary?.reason).toContain("≤20%");
    expect(result.primary?.reason).not.toContain("≤33%");
  });

  it("cuts a yellow-day session by the athlete's own percentage", () => {
    const run = makeRun({ runType: "tempo", durationMin: 60, distanceM: 10000 });
    const result = evaluated(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 50 },
        upcoming: [run],
        thresholds: tuned({ volumeReductionYellowPct: 0.4 }),
      }),
    );

    expect(result.primary?.proposedChanges).toEqual([
      { plannedRunId: run.id, field: "durationMin", from: 60, to: 36 },
      { plannedRunId: run.id, field: "distanceM", from: 10000, to: 6000 },
    ]);
  });

  it("holds an ACWR warning for an athlete with a higher spike tolerance", () => {
    const snapshot = { ...baseSnapshot, acwr: 1.6 };

    expect(evaluated(makeContext({ snapshot })).primary?.ruleId).toBe("acwr-spike");
    expect(
      evaluated(makeContext({ snapshot, thresholds: tuned({ acwrSpikeThreshold: 1.8 }) })).primary,
    ).toBeNull();
  });

  it("waits longer on HRV for an athlete who asked it to", () => {
    const snapshot = { ...baseSnapshot, hrvSuppressedConsecutiveDays: 2 };
    const upcoming = [makeRun({ runType: "tempo" })];

    expect(
      evaluated(makeContext({ snapshot, upcoming })).all.some((c) => c.ruleId === "hrv-suppressed"),
    ).toBe(true);
    expect(
      evaluated(
        makeContext({ snapshot, upcoming, thresholds: tuned({ hrvMinConsecutiveDays: 4 }) }),
      ).all.some((c) => c.ruleId === "hrv-suppressed"),
    ).toBe(false);
  });
});

describe("red-recovery-hard-session", () => {
  it("downgrades a hard session when recovery is red and next run is hard", () => {
    const run = makeRun({ runType: "tempo" });
    const result = evaluated(
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
    const result = evaluated(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 25 }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).not.toBe("red-recovery-hard-session");
  });

  it("does not fire when recovery score is null", () => {
    const run = makeRun({ runType: "tempo" });
    const result = evaluated(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: null }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).not.toBe("red-recovery-hard-session");
  });
});

describe("yellow-recovery-hard-session", () => {
  it("trims volume by the configured percentage in the yellow zone", () => {
    const run = makeRun({ runType: "long", durationMin: 100, distanceM: 20000 });
    const result = evaluated(
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
    const result = evaluated(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 20 }, upcoming: [run] }),
    );
    expect(result.primary?.ruleId).toBe("red-recovery-hard-session");
  });
});

describe("hrv-suppressed", () => {
  it("fires when HRV has been suppressed for the minimum consecutive days", () => {
    const result = evaluated(
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
    const result = evaluated(
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
    const result = evaluated(
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

  it("goes advisory instead of double-booking when the days ahead are all taken", () => {
    const run = makeRun({ runType: "interval", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const blockers = [13, 14, 15].map((d) =>
      makeRun({ runType: "easy", scheduledAt: new Date(`2026-08-${d}T14:00:00Z`) }),
    );
    const result = evaluated(
      makeContext({
        snapshot: { ...baseSnapshot, sleepDebtMinToday: 200 },
        upcoming: [run, ...blockers],
      }),
    );
    expect(result.all.find((r) => r.ruleId === "sleep-debt")?.proposedChanges).toEqual([]);
  });

  it("skips to the first free day rather than landing on an occupied one", () => {
    const run = makeRun({ runType: "interval", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const occupied = makeRun({ runType: "easy", scheduledAt: new Date("2026-08-13T14:00:00Z") });
    const result = evaluated(
      makeContext({
        snapshot: { ...baseSnapshot, sleepDebtMinToday: 200 },
        upcoming: [run, occupied],
      }),
    );
    const change = result.all.find((r) => r.ruleId === "sleep-debt")?.proposedChanges[0];
    expect(dateYmdInZone(new Date(change?.to as string), "America/New_York")).toBe("2026-08-14");
  });

  it("does not fire below the debt threshold", () => {
    const run = makeRun({ runType: "interval" });
    const result = evaluated(
      makeContext({ snapshot: { ...baseSnapshot, sleepDebtMinToday: 50 }, upcoming: [run] }),
    );
    expect(result.primary).toBeNull();
  });
});

describe("acwr-spike", () => {
  it("fires as an info-level note when ACWR exceeds the spike threshold", () => {
    const result = evaluated(makeContext({ snapshot: { ...baseSnapshot, acwr: 1.8 } }));
    expect(result.primary?.ruleId).toBe("acwr-spike");
    expect(result.primary?.severity).toBe("info");
    expect(result.primary?.proposedChanges).toEqual([]);
  });

  it("does not fire below the threshold", () => {
    const result = evaluated(makeContext({ snapshot: { ...baseSnapshot, acwr: 1.4 } }));
    expect(result.primary).toBeNull();
  });
});

describe("green-recovery-easy-day", () => {
  it("swaps today's easy run with a later hard one when recovery is high", () => {
    // Both halves of the swap must be proposed. Writing only the hard run's new time (the
    // original behaviour) left today's easy run at the same instant, stacking two runs.
    const today = makeRun({ runType: "easy", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const laterHard = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-14T14:00:00Z") });
    const result = evaluated(
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
      {
        plannedRunId: today.id,
        field: "scheduledAt",
        from: today.scheduledAt.toISOString(),
        to: laterHard.scheduledAt.toISOString(),
      },
    ]);
  });

  it("does not fire when today is already a hard day", () => {
    const today = makeRun({ runType: "tempo" });
    const result = evaluated(
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
    const result = evaluated(makeContext({ upcoming: [run], busyPeriods: [busy] }));
    expect(result.primary?.ruleId).toBe("calendar-conflict");
    expect(result.primary?.proposedChanges[0]?.plannedRunId).toBe(run.id);
    expect(result.primary?.proposedChanges[0]?.field).toBe("scheduledAt");
  });

  it("does not fire when there is no overlap", () => {
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const busy = { start: new Date("2026-08-12T16:00:00Z"), end: new Date("2026-08-12T17:00:00Z") };
    const result = evaluated(makeContext({ upcoming: [run], busyPeriods: [busy] }));
    expect(result.primary).toBeNull();
  });

  it("flags every conflicting run in the week, not just the next one", () => {
    const runA = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const runB = makeRun({ scheduledAt: new Date("2026-08-14T14:00:00Z"), durationMin: 60 });
    const clean = makeRun({ scheduledAt: new Date("2026-08-13T14:00:00Z"), durationMin: 60 });
    const busyA = { start: new Date("2026-08-12T14:00:00Z"), end: new Date("2026-08-12T15:00:00Z") };
    const busyB = { start: new Date("2026-08-14T14:00:00Z"), end: new Date("2026-08-14T15:00:00Z") };
    const result = evaluated(
      makeContext({ upcoming: [runA, clean, runB], busyPeriods: [busyA, busyB] }),
    );
    expect(result.primary?.ruleId).toBe("calendar-conflict");
    expect(result.primary?.summary).toContain("2 runs");
    const touchedRunIds = result.primary?.proposedChanges.map((c) => c.plannedRunId);
    expect(touchedRunIds).toEqual([runA.id, runB.id]);
  });

  it("does not flag a rest run even if it overlaps a busy period", () => {
    // Reproduces the reported bug: a rest run is never pushed to Google and occupies no
    // time slot, so it should never be treated as a scheduling conflict.
    const rest = makeRun({ runType: "rest", scheduledAt: new Date("2026-08-22T22:00:00Z"), durationMin: 30 });
    const busy = { start: new Date("2026-08-22T00:00:00Z"), end: new Date("2026-08-23T00:00:00Z") };
    const result = evaluated(makeContext({ upcoming: [rest], busyPeriods: [busy] }));
    expect(result.primary?.ruleId).not.toBe("calendar-conflict");
  });

  it("does not fire an actionless card when a busy block spans the entire 5am-9pm window", () => {
    // A busy span covering the whole local 5am-9pm search window (what an unfiltered
    // all-day event used to look like once converted through the freebusy API) overlaps
    // every candidate slot, so no run gets a proposed change. Emitting a recommendation
    // with no proposedChanges is a dead-end card the athlete can only dismiss — the rule
    // should return null instead.
    const run = makeRun({ runType: "easy", scheduledAt: new Date("2026-08-22T14:00:00Z"), durationMin: 60 });
    const fullWindowBusy = { start: new Date("2026-08-22T08:00:00Z"), end: new Date("2026-08-23T02:00:00Z") };
    const result = evaluated(makeContext({ upcoming: [run], busyPeriods: [fullWindowBusy] }));
    expect(result.primary?.ruleId).not.toBe("calendar-conflict");
  });

  it("proposes a slot within 5am-9pm athlete-local time, not UTC", () => {
    // 2026-08-12 is within EDT (UTC-4). A run at 14:00Z (10:00 local) conflicts with a busy
    // block right after it; the proposed slot must fall within 5am-9pm America/New_York —
    // i.e. between 09:00Z and 01:00Z the next day — not 5am-9pm UTC.
    const run = makeRun({ scheduledAt: new Date("2026-08-12T14:00:00Z"), durationMin: 60 });
    const busy = { start: new Date("2026-08-12T14:00:00Z"), end: new Date("2026-08-12T23:00:00Z") };
    const result = evaluated(
      makeContext({ upcoming: [run], busyPeriods: [busy], timeZone: "America/New_York" }),
    );
    const to = result.primary?.proposedChanges[0]?.to as string;
    expect(to).toBeDefined();
    const slot = new Date(to);
    expect(slot.getTime()).toBeGreaterThanOrEqual(new Date("2026-08-12T09:00:00Z").getTime());
    expect(slot.getTime()).toBeLessThanOrEqual(new Date("2026-08-13T01:00:00Z").getTime());
  });

  it("anchors the search window to the run's local calendar day, not its UTC day", () => {
    // 8:00 PM EDT on Aug 12 is 00:00Z on Aug 13 — a naive UTC-day window (the old bug) would
    // search Aug 13's 5am-9pm local instead of Aug 12's. The busy period conflicts with the
    // run itself but leaves the rest of Aug 12's window open, so the proposed slot must land
    // on Aug 12 local time, not Aug 13.
    const run = makeRun({ scheduledAt: new Date("2026-08-13T00:00:00Z"), durationMin: 30 });
    const busy = { start: new Date("2026-08-13T00:00:00Z"), end: new Date("2026-08-13T00:30:00Z") };
    const result = evaluated(
      makeContext({ upcoming: [run], busyPeriods: [busy], timeZone: "America/New_York" }),
    );
    const to = result.primary?.proposedChanges[0]?.to as string;
    expect(to).toBeDefined();
    expect(dateYmdInZone(new Date(to), "America/New_York")).toBe("2026-08-12");
  });
});

describe("evaluate priority ordering", () => {
  it("ranks red above yellow and surfaces info rules as secondary", () => {
    const run = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const busy = { start: new Date("2026-08-12T14:00:00Z"), end: new Date("2026-08-12T15:00:00Z") };
    const result = evaluated(
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

  it("returns an empty array when nothing fires", () => {
    const run = makeRun({ runType: "easy" });
    const result = evaluated(makeContext({ upcoming: [run] }));
    expect(result.all).toEqual([]);
    expect(result.primary).toBeNull();
  });

  it("puts an actionable rule ahead of an advisory one at the same severity", () => {
    // weatherAdvisory reports a Severe NWS alert as "red" but proposes no change. Ranking on
    // severity alone let that dead-end card headline the dashboard over a red-recovery
    // override that actually wants to change today's session.
    const run = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-12T14:00:00Z") });
    const result = evaluated(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 25 },
        upcoming: [run],
        weatherForecast: [
          {
            date: "2026-08-12",
            highTempF: 70,
            lowTempF: 55,
            shortForecast: "Storms",
            precipProbabilityPct: 20,
            windSpeed: null,
            windDirection: null,
            iconUrl: null,
            iconCode: null,
            hourly: [],
            segments: [],
            alerts: [
              {
                event: "Severe Thunderstorm Warning",
                severity: "Severe",
                headline: "Severe thunderstorms",
                effective: "2026-08-12T13:00:00Z",
                expires: "2026-08-12T18:00:00Z",
              },
            ],
          } as unknown as DailyForecast,
        ],
      }),
    );
    expect(result.primary?.ruleId).toBe("red-recovery-hard-session");
    expect(result.secondary.map((r) => r.ruleId)).toContain("weather-advisory");
  });
});

describe("today-only targeting", () => {
  it("does not touch tomorrow's session with today's recovery score", () => {
    // Recovery, sleep debt and HRV are statements about today. The old nextRun() took the
    // earliest run anywhere in the 10-day lookahead, so a rest day today let this morning's
    // red recovery score downgrade a session days out.
    const tomorrow = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-13T14:00:00Z") });
    const result = evaluated(
      makeContext({
        snapshot: { ...baseSnapshot, recoveryScore: 25, sleepDebtMinToday: 200 },
        upcoming: [tomorrow],
      }),
    );
    expect(result.all.map((r) => r.ruleId)).not.toContain("red-recovery-hard-session");
    expect(result.all.map((r) => r.ruleId)).not.toContain("sleep-debt");
  });

  it("still fires against a session later today", () => {
    const laterToday = makeRun({ runType: "tempo", scheduledAt: new Date("2026-08-12T22:00:00Z") });
    const result = evaluated(
      makeContext({ snapshot: { ...baseSnapshot, recoveryScore: 25 }, upcoming: [laterToday] }),
    );
    expect(result.primary?.ruleId).toBe("red-recovery-hard-session");
  });
});

describe("rankOutputs across sources", () => {
  const src = (id: string): RecommendationSource => ({ id, version: null, generate: async () => [] });
  const out = (overrides: Partial<RuleOutput> & Pick<RuleOutput, "ruleId">): RuleOutput => ({
    severity: "yellow",
    summary: `${overrides.ruleId} summary`,
    reason: `${overrides.ruleId} reason.`,
    proposedChanges: [],
    ...overrides,
  });
  const change = { plannedRunId: "run-1", field: "scheduledAt", from: "a", to: "b" };

  it("keeps the red rules card first even when only the model proposes a change", () => {
    // The safety floor. Without it, actionable-before-advisory would hand the headline to the
    // model on exactly the day the deterministic recovery override matters most.
    const ranked = rankOutputs([
      { source: src("rules"), output: out({ ruleId: "red-recovery-hard-session", severity: "red" }) },
      {
        source: src("model"),
        output: out({ ruleId: "model-taper", severity: "red", proposedChanges: [change] }),
      },
    ]);

    expect(ranked.map((r) => r.output.ruleId)).toEqual(["red-recovery-hard-session", "model-taper"]);
  });

  it("applies the floor only at red — lower severities rank on their own merits", () => {
    const ranked = rankOutputs([
      { source: src("rules"), output: out({ ruleId: "acwr-spike", severity: "yellow" }) },
      {
        source: src("model"),
        output: out({ ruleId: "model-trim", severity: "yellow", proposedChanges: [change] }),
      },
    ]);

    expect(ranked.map((r) => r.output.ruleId)).toEqual(["model-trim", "acwr-spike"]);
  });

  it("still ranks severity above everything, source included", () => {
    const ranked = rankOutputs([
      { source: src("rules"), output: out({ ruleId: "green-recovery", severity: "info" }) },
      { source: src("model"), output: out({ ruleId: "model-red", severity: "red" }) },
    ]);

    expect(ranked.map((r) => r.output.ruleId)).toEqual(["model-red", "green-recovery"]);
  });

  it("falls through to input order for a genuine tie", () => {
    const ranked = rankOutputs([
      { source: src("rules"), output: out({ ruleId: "first", severity: "info" }) },
      { source: src("rules"), output: out({ ruleId: "second", severity: "info" }) },
    ]);

    expect(ranked.map((r) => r.output.ruleId)).toEqual(["first", "second"]);
  });
});
