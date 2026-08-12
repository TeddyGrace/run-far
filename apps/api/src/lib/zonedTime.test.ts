import { describe, expect, it } from "vitest";
import { dateYmdInZone, shiftRunsToLocalTime, zonedLocalToIso } from "./zonedTime.js";

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
