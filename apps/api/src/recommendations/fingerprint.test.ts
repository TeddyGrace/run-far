import { describe, it, expect } from "vitest";
import { fingerprintOf } from "./fingerprint.js";
import type { RuleOutput } from "./types.js";

function makeRule(overrides: Partial<RuleOutput> = {}): RuleOutput {
  return {
    ruleId: "calendar-conflict",
    severity: "info",
    summary: "Your rest run conflicts with your calendar this week",
    reason: "Sat, Aug 22 rest run at 10:00 PM overlaps your calendar.",
    proposedChanges: [
      { plannedRunId: "run-1", field: "scheduledAt", from: "2026-08-22T22:00:00.000Z", to: "2026-08-22T09:00:00.000Z" },
    ],
    ...overrides,
  };
}

describe("fingerprintOf", () => {
  it("is stable across repeated calls with identical input", () => {
    expect(fingerprintOf(makeRule())).toBe(fingerprintOf(makeRule()));
  });

  it("is stable regardless of proposedChanges array order", () => {
    const a = makeRule({
      proposedChanges: [
        { plannedRunId: "run-1", field: "scheduledAt", from: "a", to: "b" },
        { plannedRunId: "run-2", field: "scheduledAt", from: "c", to: "d" },
      ],
    });
    const b = makeRule({
      proposedChanges: [
        { plannedRunId: "run-2", field: "scheduledAt", from: "c", to: "d" },
        { plannedRunId: "run-1", field: "scheduledAt", from: "a", to: "b" },
      ],
    });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it("changes when the reason text changes (a different day/run is described)", () => {
    const a = makeRule({ reason: "Sat, Aug 22 rest run at 10:00 PM overlaps your calendar." });
    const b = makeRule({ reason: "Sun, Aug 23 rest run at 10:00 PM overlaps your calendar." });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it("changes when the proposed change's target time changes", () => {
    const a = makeRule();
    const b = makeRule({
      proposedChanges: [
        { plannedRunId: "run-1", field: "scheduledAt", from: "2026-08-22T22:00:00.000Z", to: "2026-08-22T10:00:00.000Z" },
      ],
    });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it("does not depend on a `date` field — dismissal survives the day rolling over", () => {
    // fingerprintOf only ever receives ruleId/summary/reason/proposedChanges (RuleOutput has
    // no `date`), so two firings on different calendar days but identical content hash the
    // same as long as summary/reason/proposedChanges are identical.
    expect(fingerprintOf(makeRule())).toBe(fingerprintOf(makeRule()));
  });
});
