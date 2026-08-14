import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_CLIENT_ID ??= "test-client-id";
process.env.WHOOP_CLIENT_SECRET ??= "test-client-secret";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

const { strainToLoad, cycleLoad, cycleLocalDate } = await import("./cycleMetrics.js");

describe("strainToLoad", () => {
  it("is monotonically increasing", () => {
    expect(strainToLoad(5)).toBeLessThan(strainToLoad(10));
    expect(strainToLoad(10)).toBeLessThan(strainToLoad(20));
  });

  it("maps max strain (21) to roughly 1000 load units, per the calibration note in config.ts", () => {
    expect(strainToLoad(21)).toBeGreaterThan(900);
    expect(strainToLoad(21)).toBeLessThan(1100);
  });
});

describe("cycleLoad", () => {
  it("prefers kilojoule (a real linear measure) when present", () => {
    expect(cycleLoad({ kilojoule: 5000, strain: 18 })).toBe(5000);
  });

  it("falls back to the strain approximation when kilojoule is null", () => {
    expect(cycleLoad({ kilojoule: null, strain: 18 })).toBe(strainToLoad(18));
  });

  it("returns null when neither source field is available", () => {
    expect(cycleLoad({ kilojoule: null, strain: null })).toBeNull();
  });
});

describe("cycleLocalDate", () => {
  it("crosses midnight correctly when the cycle's own offset differs from UTC", () => {
    // 23:30 in UTC-04:00 is 2026-08-12 03:30 UTC — a naive UTC slice would read "2026-08-12".
    const start = new Date("2026-08-12T03:30:00Z");
    expect(cycleLocalDate({ start, timezoneOffset: "-04:00" }, "America/New_York")).toBe("2026-08-11");
  });

  it("uses a cycle spanning >24h correctly — only the start instant matters for the label", () => {
    const start = new Date("2026-08-10T10:00:00Z"); // 06:00 -04:00
    expect(cycleLocalDate({ start, timezoneOffset: "-04:00" }, "America/New_York")).toBe("2026-08-10");
  });

  it("falls back to the caller-supplied fallback timezone when the cycle has no recorded offset", () => {
    // 23:30 America/New_York (EDT, -04:00) is 2026-08-12 03:30 UTC.
    const start = new Date("2026-08-12T03:30:00Z");
    expect(cycleLocalDate({ start, timezoneOffset: null }, "America/New_York")).toBe("2026-08-11");
  });
});
