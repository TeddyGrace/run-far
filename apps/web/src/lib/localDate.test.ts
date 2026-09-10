import { describe, it, expect } from "vitest";
import { addDaysYmd, localWeekDays, mondayYmd, toLocalYmd, todayYmd, withLocalYmd, ymdToLocalDate } from "./localDate.js";

// The suite runs with TZ=America/New_York (see vitest.config.ts) so that "the browser's
// zone" is a negative offset — the case where a UTC slice and the athlete's calendar
// disagree, which is the bug these helpers exist to fix.

describe("toLocalYmd", () => {
  it("keeps a 9pm instant on the day the athlete is living", () => {
    // 9pm Wed Sep 9 in New York is already Thu Sep 10 in UTC.
    const ninePmWednesday = new Date("2026-09-10T01:00:00Z");
    expect(ninePmWednesday.toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(toLocalYmd(ninePmWednesday)).toBe("2026-09-09");
  });

  it("agrees with UTC during the local morning", () => {
    expect(toLocalYmd(new Date("2026-09-10T14:00:00Z"))).toBe("2026-09-10");
  });
});

describe("todayYmd", () => {
  it("reports the local date, not the UTC one", () => {
    expect(todayYmd(new Date("2026-09-10T01:00:00Z"))).toBe("2026-09-09");
  });
});

describe("addDaysYmd", () => {
  it("steps whole calendar days", () => {
    expect(addDaysYmd("2026-09-09", 1)).toBe("2026-09-10");
    expect(addDaysYmd("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("advances exactly one day across a DST transition", () => {
    // Nov 1 2026 is the US fall-back day — 25 hours long.
    expect(addDaysYmd("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysYmd("2026-11-01", 1)).toBe("2026-11-02");
    // And the spring-forward day, which is 23 hours long.
    expect(addDaysYmd("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDaysYmd("2026-03-08", 1)).toBe("2026-03-09");
  });
});

describe("mondayYmd", () => {
  it("returns the same date for a Monday and steps back otherwise", () => {
    expect(mondayYmd("2026-09-07")).toBe("2026-09-07"); // Monday
    expect(mondayYmd("2026-09-09")).toBe("2026-09-07"); // Wednesday
    expect(mondayYmd("2026-09-13")).toBe("2026-09-07"); // Sunday
  });
});

describe("localWeekDays", () => {
  it("builds the local week containing 9pm Wednesday, not the UTC-next-day week", () => {
    const ninePmWednesday = new Date("2026-09-10T01:00:00Z");
    expect(localWeekDays(0, ninePmWednesday)).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });

  it("offsets by whole weeks", () => {
    const now = new Date("2026-09-09T16:00:00Z");
    expect(localWeekDays(-1, now)[0]).toBe("2026-08-31");
    expect(localWeekDays(1, now)[0]).toBe("2026-09-14");
  });
});

describe("withLocalYmd", () => {
  it("keeps the local wall-clock time when a run is dragged to another day", () => {
    const sixThirtyAm = new Date("2026-09-09T10:30:00Z"); // 6:30am New York
    const moved = withLocalYmd(sixThirtyAm, "2026-09-11");
    expect(toLocalYmd(moved)).toBe("2026-09-11");
    expect(moved.toISOString()).toBe("2026-09-11T10:30:00.000Z");
  });

  it("keeps the wall-clock time across a DST boundary rather than the UTC offset", () => {
    const sixThirtyAmEdt = new Date("2026-10-30T10:30:00Z"); // 6:30am EDT (UTC-4)
    const moved = withLocalYmd(sixThirtyAmEdt, "2026-11-06"); // after fall-back, EST (UTC-5)
    expect(toLocalYmd(moved)).toBe("2026-11-06");
    expect(moved.toISOString()).toBe("2026-11-06T11:30:00.000Z");
    expect(moved.getHours()).toBe(6);
    expect(moved.getMinutes()).toBe(30);
  });

  it("moves an evening run whose UTC date is already the next day", () => {
    const ninePm = new Date("2026-09-10T01:00:00Z"); // 9pm Wed Sep 9 local
    const moved = withLocalYmd(ninePm, "2026-09-11");
    expect(toLocalYmd(moved)).toBe("2026-09-11");
    expect(moved.getHours()).toBe(21);
  });
});

describe("ymdToLocalDate", () => {
  it("anchors to local midnight so weekday/day-of-month render as written", () => {
    const d = ymdToLocalDate("2026-09-09");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(0);
  });
});
