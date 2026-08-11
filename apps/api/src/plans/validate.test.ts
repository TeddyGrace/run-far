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
});
