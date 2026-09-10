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

  // An athlete planning at 9pm is still on today's date; without the zone the window would
  // start from tomorrow, and "next Monday" would jump a whole week when they plan on a
  // Sunday evening.
  it("resolves today in the athlete's timezone, not UTC", () => {
    const ninePmMonday = new Date("2026-08-11T01:00:00Z"); // 9pm Mon Aug 10 in New York
    const res = computePlanWindow({
      today: ninePmMonday,
      timeZone: "America/New_York",
      preferStart: "today",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.window.todayIso).toBe("2026-08-10");
    expect(res.window.startDate).toBe("2026-08-10");
  });

  it("does not skip a week when planning on a Sunday evening", () => {
    const ninePmSunday = new Date("2026-08-17T01:00:00Z"); // 9pm Sun Aug 16 in New York
    const res = computePlanWindow({
      today: ninePmSunday,
      timeZone: "America/New_York",
      preferStart: "next_monday",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Tomorrow, Aug 17 — not Aug 24, which is what a UTC "today" of Mon Aug 17 would give.
    expect(res.window.startDate).toBe("2026-08-17");
  });
});
