import { describe, expect, it } from "vitest";
import { buildTrainingContext } from "./trainingContext.js";
import type { BusyPeriod, PlannedRunRow } from "./types.js";

/**
 * Pure-function suite — no database. buildTrainingContext is what turns a card's bare
 * `plannedRunId` into a record of what was actually being changed, and it is the only place the
 * athlete's calendar data is filtered before being written somewhere long-lived, so the
 * exclusion of event titles is tested as a hard guarantee rather than assumed from the code.
 */

const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function run(overrides: Partial<PlannedRunRow> & Pick<PlannedRunRow, "id">): PlannedRunRow {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    planId: null,
    scheduledAt: new Date("2026-03-02T12:00:00Z"),
    durationMin: 60,
    distanceM: 10_000,
    runType: "easy",
    targetPaceSPerKm: 300,
    plannedTss: 55,
    description: null,
    structure: null,
    status: "planned",
    gcalEventId: null,
    gcalEtag: null,
    origin: "manual",
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: new Date("2026-03-01T00:00:00Z"),
    ...overrides,
  } as PlannedRunRow;
}

const busy = (start: string, end: string, summary?: string): BusyPeriod => ({
  start: new Date(start),
  end: new Date(end),
  ...(summary === undefined ? {} : { summary }),
});

const change = (plannedRunId: string) => ({
  plannedRunId,
  field: "scheduledAt",
  from: "2026-03-02T12:00:00.000Z",
  to: "2026-03-02T15:00:00.000Z",
});

describe("buildTrainingContext", () => {
  it("projects every distinct target run a card proposes changing", () => {
    const upcoming = [
      run({ id: RUN_A, runType: "long", distanceM: 32_000, durationMin: 180, plannedTss: 210 }),
      run({ id: RUN_B, runType: "recovery", distanceM: 5_000, durationMin: 30, plannedTss: 25 }),
      run({ id: RUN_C }),
    ];

    // Two changes against RUN_A, one against RUN_B — the run is the unit, not the change, so
    // RUN_A must appear once. RUN_C is untouched by this card and must not be recorded.
    const ctx = { upcoming, busyPeriods: [] };
    const result = buildTrainingContext(
      {
        proposedChanges: [
          change(RUN_A),
          { ...change(RUN_A), field: "durationMin", from: 180, to: 150 },
          change(RUN_B),
        ],
      },
      ctx,
    );

    expect(result.targetRuns.map((r) => r.id)).toEqual([RUN_A, RUN_B]);
    expect(result.targetRuns[0]).toEqual({
      id: RUN_A,
      scheduledAt: "2026-03-02T12:00:00.000Z",
      runType: "long",
      distanceM: 32_000,
      durationMin: 180,
      targetPaceSPerKm: 300,
      plannedTss: 210,
      status: "planned",
    });
    // The distinction the column exists to preserve: a 20-mile long run and a 3-mile shakeout
    // are indistinguishable from proposed_changes alone.
    expect(result.targetRuns[1]?.runType).toBe("recovery");
    expect(result.targetRuns[1]?.distanceM).toBe(5_000);
  });

  it("yields empty arrays for an advisory card with no proposed changes", () => {
    const result = buildTrainingContext(
      { proposedChanges: [] },
      { upcoming: [run({ id: RUN_A })], busyPeriods: [busy("2026-03-02T12:30:00Z", "2026-03-02T13:00:00Z")] },
    );

    // An advisory card targets no run, so it conflicts with nothing — the column is empty
    // rather than half-populated with busy periods no card depended on.
    expect(result).toEqual({ targetRuns: [], conflictWindows: [] });
  });

  it("captures only busy periods that overlap a target run", () => {
    const upcoming = [
      // 12:00-13:00Z
      run({ id: RUN_A, scheduledAt: new Date("2026-03-02T12:00:00Z"), durationMin: 60 }),
    ];
    const busyPeriods = [
      busy("2026-03-02T12:30:00Z", "2026-03-02T13:30:00Z", "Overlaps the back half"),
      busy("2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z", "Earlier, no overlap"),
      // Touching endpoints are not a conflict — the run ends exactly as this starts.
      busy("2026-03-02T13:00:00Z", "2026-03-02T14:00:00Z", "Starts on the boundary"),
    ];

    const result = buildTrainingContext({ proposedChanges: [change(RUN_A)] }, { upcoming, busyPeriods });

    expect(result.conflictWindows).toEqual([
      { start: "2026-03-02T12:30:00.000Z", end: "2026-03-02T13:30:00.000Z" },
    ]);
  });

  it("records one window when the same busy period conflicts with two target runs", () => {
    const upcoming = [
      run({ id: RUN_A, scheduledAt: new Date("2026-03-02T12:00:00Z"), durationMin: 60 }),
      run({ id: RUN_B, scheduledAt: new Date("2026-03-02T12:30:00Z"), durationMin: 60 }),
    ];
    const busyPeriods = [busy("2026-03-02T12:15:00Z", "2026-03-02T13:15:00Z", "One long meeting")];

    const result = buildTrainingContext(
      { proposedChanges: [change(RUN_A), change(RUN_B)] },
      { upcoming, busyPeriods },
    );

    expect(result.targetRuns).toHaveLength(2);
    expect(result.conflictWindows).toHaveLength(1);
  });

  it("skips a proposed change naming a run the engine did not hold", () => {
    // The run has moved out of the lookahead window. Nothing truthful can be recorded about it,
    // so it is omitted rather than written as a placeholder that would read as real data later.
    const result = buildTrainingContext(
      { proposedChanges: [change(RUN_A), change(RUN_C)] },
      { upcoming: [run({ id: RUN_A })], busyPeriods: [] },
    );

    expect(result.targetRuns.map((r) => r.id)).toEqual([RUN_A]);
  });

  it("never lets a calendar event title reach the output", () => {
    const upcoming = [run({ id: RUN_A, scheduledAt: new Date("2026-03-02T12:00:00Z"), durationMin: 60 })];
    const busyPeriods = [
      busy("2026-03-02T12:30:00Z", "2026-03-02T13:00:00Z", "Oncology appointment"),
      busy("2026-03-02T12:45:00Z", "2026-03-02T13:15:00Z", "Divorce mediation"),
    ];

    const result = buildTrainingContext({ proposedChanges: [change(RUN_A)] }, { upcoming, busyPeriods });

    // The overlap window is what a model can learn from; the title is personal data from a
    // third-party account, pulled in for a transient scheduling decision. Asserted over the
    // serialized output so no nested field can smuggle one through.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Oncology");
    expect(serialized).not.toContain("Divorce mediation");
    expect(serialized).not.toContain("summary");

    expect(result.conflictWindows).toHaveLength(2);
    for (const window of result.conflictWindows) {
      expect(Object.keys(window).sort()).toEqual(["end", "start"]);
    }
  });
});
