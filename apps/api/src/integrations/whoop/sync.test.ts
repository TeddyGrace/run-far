import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_CLIENT_ID ??= "test-client-id";
process.env.WHOOP_CLIENT_SECRET ??= "test-client-secret";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

const { toLocalDateOnly } = await import("./sync.js");

// The decisive regression test: before this fix, workout/sleep/recovery dates were sliced
// straight off the raw UTC ISO string (`iso.slice(0, 10)`), so any evening activity in a
// negative-UTC-offset timezone landed on the *next* calendar day — corrupting daily/weekly
// rollups and the once-per-day digest gate.
describe("toLocalDateOnly", () => {
  it("keeps a late-evening Eastern-time workout on its own local day, not the next UTC day", () => {
    // 21:00 EDT (-04:00) on Aug 11 is 01:00 UTC on Aug 12 — the old UTC-slice bug would read
    // this as "2026-08-12".
    const workoutStart = "2026-08-11T21:00:00-04:00";
    expect(toLocalDateOnly(workoutStart, "America/New_York")).toBe("2026-08-11");
  });

  it("agrees with a raw UTC timestamp expressing the same instant", () => {
    expect(toLocalDateOnly("2026-08-12T01:00:00Z", "America/New_York")).toBe("2026-08-11");
  });

  it("still lands on the same day for a daytime workout, where UTC-slicing happened to be right", () => {
    // 10:00 EDT (-04:00) on Aug 11 is 14:00 UTC on Aug 11 — both approaches agree here,
    // which is exactly why the bug went unnoticed for morning/daytime activity.
    expect(toLocalDateOnly("2026-08-11T10:00:00-04:00", "America/New_York")).toBe("2026-08-11");
  });

  it("also agrees with UTC-slicing for a just-after-midnight Eastern workout", () => {
    // 00:30 EDT (-04:00) on Aug 12 is 04:30 UTC on Aug 12 — both approaches land on Aug 12
    // here; the divergence only shows up once the local hour is late enough to push the
    // UTC-equivalent instant past midnight into the next day.
    expect(toLocalDateOnly("2026-08-12T00:30:00-04:00", "America/New_York")).toBe("2026-08-12");
  });
});
