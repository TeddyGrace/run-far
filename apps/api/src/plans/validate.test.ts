import { describe, it, expect } from "vitest";
import { validatePlanDraft } from "./validate.js";
import type { AiPlanDraft } from "@run-far/shared";

const today = new Date("2026-08-11T12:00:00Z");

function draft(runs: AiPlanDraft["runs"]): AiPlanDraft {
  return { name: "Test", runs };
}

describe("validatePlanDraft", () => {
  it("flags a run after race day as an error", () => {
    const res = validatePlanDraft({
      draft: draft([
        { scheduledAt: "2026-08-12T07:00:00Z", runType: "easy", distanceM: 8000 },
        { scheduledAt: "2026-09-08T07:00:00Z", runType: "long", distanceM: 20000 },
      ]),
      today,
      startDate: "2026-08-11",
      raceDate: "2026-09-07",
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /after race day/.test(e))).toBe(true);
  });

  it("flags a run before the start date", () => {
    const res = validatePlanDraft({
      draft: draft([{ scheduledAt: "2026-08-05T07:00:00Z", runType: "easy", distanceM: 5000 }]),
      today,
      startDate: "2026-08-11",
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => /before the plan start/.test(e))).toBe(true);
  });

  it("allows past runs as a warning when revising without an explicit startDate", () => {
    const res = validatePlanDraft({
      draft: draft([{ scheduledAt: "2026-08-05T07:00:00Z", runType: "easy", distanceM: 5000 }]),
      today,
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => /before today/.test(w))).toBe(true);
  });

  it("warns on a steep week-over-week mileage jump", () => {
    const res = validatePlanDraft({
      draft: draft([
        { scheduledAt: "2026-08-11T07:00:00Z", runType: "long", distanceM: 10000 },
        { scheduledAt: "2026-08-18T07:00:00Z", runType: "long", distanceM: 20000 },
      ]),
      today,
      startDate: "2026-08-11",
    });
    expect(res.warnings.some((w) => /jumps/.test(w))).toBe(true);
  });

  it("passes a sane in-bounds plan", () => {
    const res = validatePlanDraft({
      draft: draft([
        { scheduledAt: "2026-08-12T07:00:00Z", runType: "easy", distanceM: 8000 },
        { scheduledAt: "2026-08-14T07:00:00Z", runType: "tempo", distanceM: 9000 },
        { scheduledAt: "2026-08-16T07:00:00Z", runType: "long", distanceM: 14000 },
      ]),
      today,
      startDate: "2026-08-11",
      raceDate: "2026-09-07",
    });
    expect(res.valid).toBe(true);
  });

  // The coach is told to write scheduledAt with the athlete's offset, but a bare-UTC
  // timestamp for an evening run still has to be judged on the day the athlete runs it.
  describe("timezone", () => {
    it("counts a late-evening run on its local day, not the next UTC one", () => {
      const res = validatePlanDraft({
        draft: draft([{ scheduledAt: "2026-09-08T01:00:00Z", runType: "race", distanceM: 42195 }]),
        today: new Date("2026-08-11T12:00:00Z"),
        timeZone: "America/New_York",
        startDate: "2026-08-11",
        raceDate: "2026-09-07",
      });
      // 9pm Sep 7 local — race day, not the day after it.
      expect(res.errors.some((e) => /after race day/.test(e))).toBe(false);
      expect(res.warnings.some((w) => /No run of type "race"/.test(w))).toBe(false);
      expect(res.stats.lastDate).toBe("2026-09-07");
    });

    it("still reads a run written with an explicit offset as its local day", () => {
      const res = validatePlanDraft({
        draft: draft([{ scheduledAt: "2026-09-07T21:00:00-04:00", runType: "race", distanceM: 42195 }]),
        today: new Date("2026-08-11T12:00:00Z"),
        timeZone: "America/New_York",
        startDate: "2026-08-11",
        raceDate: "2026-09-07",
      });
      expect(res.stats.lastDate).toBe("2026-09-07");
      expect(res.errors).toEqual([]);
    });

    it("resolves today in the athlete's timezone when warning about past runs", () => {
      const res = validatePlanDraft({
        draft: draft([{ scheduledAt: "2026-08-11T14:00:00Z", runType: "easy", distanceM: 5000 }]),
        // 9pm Mon Aug 10 in New York: a Tuesday-morning run is still in the future.
        today: new Date("2026-08-11T01:00:00Z"),
        timeZone: "America/New_York",
      });
      expect(res.warnings.some((w) => /before today/.test(w))).toBe(false);
    });
  });
});
