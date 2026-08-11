import { describe, it, expect } from "vitest";
import { computePlanWindow } from "./planWindow.js";

const today = new Date("2026-08-11T12:00:00Z"); // Tuesday

describe("computePlanWindow", () => {
  it("counts weeks to a race date inclusively", () => {
    const res = computePlanWindow({ today, startDate: "2026-08-11", raceDate: "2026-09-07" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.window.startDate).toBe("2026-08-11");
    expect(res.window.endDate).toBe("2026-09-07");
    expect(res.window.totalDays).toBe(28);
    expect(res.window.completeWeeks).toBe(4);
    expect(res.window.hasRace).toBe(true);
  });

  it("rejects a race date before the start", () => {
    const res = computePlanWindow({ today, startDate: "2026-09-01", raceDate: "2026-08-20" });
    expect(res.ok).toBe(false);
  });

  it("clamps a past start date to today", () => {
    const res = computePlanWindow({ today, startDate: "2026-08-01", goalDate: "2026-09-01" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.window.startDate).toBe("2026-08-11");
    expect(res.window.notes.join(" ")).toMatch(/past/);
  });

  it("defaults to an 8-week block with no target", () => {
    const res = computePlanWindow({ today, preferStart: "next_monday" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.window.hasRace).toBe(false);
    // Next Monday after Tue Aug 11 is Aug 17.
    expect(res.window.startDate).toBe("2026-08-17");
  });
});
