import { describe, it, expect } from "vitest";
import { isChangeStale } from "./changeStaleness.js";
import type { PlannedRunRow } from "./types.js";
import type { ProposedChange } from "@run-far/shared";

function makeRun(overrides: Partial<PlannedRunRow> = {}): PlannedRunRow {
  return {
    id: "run-1",
    userId: "user-1",
    planId: null,
    scheduledAt: new Date("2026-08-12T14:00:00Z"),
    durationMin: 60,
    distanceM: 10000,
    runType: "tempo",
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
  } as PlannedRunRow;
}

function change(overrides: Partial<ProposedChange>): ProposedChange {
  return { plannedRunId: "run-1", field: "runType", from: "tempo", to: "easy", ...overrides };
}

describe("isChangeStale", () => {
  it("is not stale when the run still holds the value the rule saw", () => {
    expect(isChangeStale(makeRun(), change({}))).toBe(false);
  });

  it("is stale when the athlete changed the field after the card was generated", () => {
    expect(isChangeStale(makeRun({ runType: "easy" }), change({}))).toBe(true);
  });

  it("compares scheduledAt by instant, not by object identity", () => {
    const c = change({ field: "scheduledAt", from: "2026-08-12T14:00:00.000Z", to: "2026-08-13T14:00:00.000Z" });
    expect(isChangeStale(makeRun(), c)).toBe(false);
    // The same wall-clock instant written a different way still matches.
    expect(isChangeStale(makeRun(), change({ ...c, from: "2026-08-12T10:00:00-04:00" }))).toBe(false);
    // A run that has since been dragged an hour later does not.
    expect(isChangeStale(makeRun({ scheduledAt: new Date("2026-08-12T15:00:00Z") }), c)).toBe(true);
  });

  it("handles nullable numeric fields in both directions", () => {
    expect(isChangeStale(makeRun(), change({ field: "durationMin", from: 60, to: 48 }))).toBe(false);
    expect(isChangeStale(makeRun({ durationMin: null }), change({ field: "durationMin", from: 60, to: 48 }))).toBe(true);
    expect(
      isChangeStale(makeRun({ targetPaceSPerKm: null }), change({ field: "targetPaceSPerKm", from: null, to: null })),
    ).toBe(false);
  });

  it("treats a missing run as stale", () => {
    expect(isChangeStale(undefined, change({}))).toBe(true);
  });

  it("treats an unparseable scheduledAt `from` as stale rather than overwriting blindly", () => {
    expect(isChangeStale(makeRun(), change({ field: "scheduledAt", from: "not-a-date", to: "x" }))).toBe(true);
  });
});
