import { describe, expect, it } from "vitest";
import { addLocalDays, dateYmdInZone, hourInZone, shiftRunsToLocalTime, zonedLocalToIso } from "./zonedTime.js";

describe("zonedTime", () => {
  it("converts Eastern afternoon wall clock to UTC", () => {
    // 2026-08-12 16:30 EDT = 20:30 UTC
    const iso = zonedLocalToIso("2026-08-12", "16:30", "America/New_York");
    expect(iso).toBe("2026-08-12T20:30:00.000Z");
  });

  it("converts Eastern morning wall clock to UTC", () => {
    // 2026-08-12 07:00 EDT = 11:00 UTC
    const iso = zonedLocalToIso("2026-08-12", "07:00", "America/New_York");
    expect(iso).toBe("2026-08-12T11:00:00.000Z");
  });

  it("preserves calendar day when shifting a UTC morning run to local afternoon", () => {
    // 07:00Z on Aug 12 is 03:00 EDT — calendar day in NY is still Aug 12
    const [shifted] = shiftRunsToLocalTime(
      [{ scheduledAt: "2026-08-12T07:00:00.000Z", runType: "easy" }],
      "16:30",
      "America/New_York",
    );
    expect(shifted!.scheduledAt).toBe("2026-08-12T20:30:00.000Z");
    expect(dateYmdInZone(new Date(shifted!.scheduledAt), "America/New_York")).toBe("2026-08-12");
  });
});

const NY = "America/New_York";

describe("addLocalDays", () => {
  it("keeps the athlete's wall-clock time across a spring-forward boundary", () => {
    // 2026-03-08 is the US spring-forward date. A 7:00am run on Mar 7 must still be a 7:00am
    // run on Mar 8 — adding 24h in UTC (the shift sleep-debt used to do) would make it 8:00am.
    const before = new Date("2026-03-07T12:00:00Z"); // 07:00 EST
    expect(hourInZone(before, NY)).toBe(7);

    const after = addLocalDays(before, 1, NY);
    expect(dateYmdInZone(after, NY)).toBe("2026-03-08");
    expect(hourInZone(after, NY)).toBe(7);
    expect(after.toISOString()).toBe("2026-03-08T11:00:00.000Z"); // one UTC hour earlier
  });

  it("keeps the wall-clock time across a fall-back boundary", () => {
    const before = new Date("2026-10-31T11:00:00Z"); // 07:00 EDT
    expect(hourInZone(before, NY)).toBe(7);

    const after = addLocalDays(before, 1, NY);
    expect(dateYmdInZone(after, NY)).toBe("2026-11-01");
    expect(hourInZone(after, NY)).toBe(7);
    expect(after.toISOString()).toBe("2026-11-01T12:00:00.000Z"); // one UTC hour later
  });

  it("shifts by more than one day and across a month boundary", () => {
    const after = addLocalDays(new Date("2026-08-30T14:00:00Z"), 3, NY);
    expect(dateYmdInZone(after, NY)).toBe("2026-09-02");
    expect(hourInZone(after, NY)).toBe(10);
  });

  it("is a plain 24h shift when no DST boundary is crossed", () => {
    const after = addLocalDays(new Date("2026-08-12T14:00:00Z"), 1, NY);
    expect(after.toISOString()).toBe("2026-08-13T14:00:00.000Z");
  });
});
