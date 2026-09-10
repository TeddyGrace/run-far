import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

/**
 * The busy-period TTL cache.
 *
 * Regenerating recommendations is what a dashboard read does before it answers, so this call
 * used to cost a Google API round trip per page view. These assertions are about how often the
 * underlying list is reached — the behaviour the cache exists for — plus the two ways a naive
 * cache would be wrong: serving a window narrower than the one asked for, and leaking one
 * athlete's calendar to another.
 */
const listed = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string; timeMin: string; timeMax: string }>,
  events: [] as Array<{ start: string; end: string; summary?: string }>,
}));

// Stubbed at the Google boundary rather than at listPrimaryEvents, so everything between the
// cache and the network — the wrapper, the blocking-event filter, the window arithmetic — is
// the real code under test.
vi.mock("googleapis", () => ({
  google: {
    calendar: () => ({
      events: {
        list: async (params: { timeMin: string; timeMax: string }) => {
          listed.calls.push({ userId: "n/a", timeMin: params.timeMin, timeMax: params.timeMax });
          return { data: { items: listed.events.map((e) => ({ id: "e", status: "confirmed", start: { dateTime: e.start }, end: { dateTime: e.end }, summary: e.summary, transparency: "opaque" })) } };
        },
      },
    }),
  },
}));

// getAuthedClient would reach for the database and a real OAuth token.
vi.mock("./oauth.js", () => ({
  getAuthedClient: async () => ({}),
  getConnectionMetadata: async () => ({}),
  setConnectionMetadata: async () => {},
  isInvalidGrant: () => false,
}));

const { getPrimaryBusyPeriodsCached, invalidateBusyPeriods } = await import("./calendarClient.js");

const NOW = new Date("2025-06-11T15:00:00Z");
const WINDOW_MIN = NOW.toISOString();
const WINDOW_MAX = new Date(NOW.getTime() + 10 * 86_400_000).toISOString();

beforeEach(() => {
  listed.calls = [];
  listed.events = [{ start: "2025-06-12T14:00:00Z", end: "2025-06-12T15:00:00Z", summary: "Standup" }];
  invalidateBusyPeriods("user-a");
  invalidateBusyPeriods("user-b");
});

describe("getPrimaryBusyPeriodsCached", () => {
  it("fetches once and reuses the result inside the TTL", async () => {
    const first = await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);
    const second = await getPrimaryBusyPeriodsCached(
      "user-a",
      new Date(NOW.getTime() + 60_000).toISOString(),
      new Date(NOW.getTime() + 60_000 + 10 * 86_400_000).toISOString(),
      new Date(NOW.getTime() + 60_000),
    );

    expect(listed.calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("fetches a padded window so a slightly later request still hits", async () => {
    await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);

    // Without the pad, the window asked for a minute later would run past the cached one by a
    // minute and every request would miss — a cache that never hits is just latency.
    const fetchedMax = new Date(listed.calls[0]!.timeMax).getTime();
    expect(fetchedMax).toBeGreaterThan(new Date(WINDOW_MAX).getTime());
  });

  it("refetches once the TTL lapses", async () => {
    await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);
    const later = new Date(NOW.getTime() + 6 * 60_000);
    await getPrimaryBusyPeriodsCached(
      "user-a",
      later.toISOString(),
      new Date(later.getTime() + 10 * 86_400_000).toISOString(),
      later,
    );

    expect(listed.calls).toHaveLength(2);
  });

  it("refetches when asked for a window the cached one does not contain", async () => {
    await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);

    // A far longer lookahead. Serving the narrower cached window would report "nothing
    // scheduled" for days that were simply never fetched.
    await getPrimaryBusyPeriodsCached(
      "user-a",
      WINDOW_MIN,
      new Date(NOW.getTime() + 60 * 86_400_000).toISOString(),
      NOW,
    );

    expect(listed.calls).toHaveLength(2);
  });

  it("keeps one athlete's calendar out of another's", async () => {
    await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);
    listed.events = [{ start: "2025-06-13T10:00:00Z", end: "2025-06-13T11:00:00Z", summary: "Dentist" }];
    const b = await getPrimaryBusyPeriodsCached("user-b", WINDOW_MIN, WINDOW_MAX, NOW);

    expect(listed.calls).toHaveLength(2);
    expect(b[0]?.summary).toBe("Dentist");
  });

  it("refetches after an explicit invalidation", async () => {
    await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);
    invalidateBusyPeriods("user-a");
    await getPrimaryBusyPeriodsCached("user-a", WINDOW_MIN, WINDOW_MAX, NOW);

    expect(listed.calls).toHaveLength(2);
  });
});
