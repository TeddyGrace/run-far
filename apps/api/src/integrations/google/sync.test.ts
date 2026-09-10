import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

/**
 * Two-way Google Calendar sync, against a fake calendar.
 *
 * These paths were previously verified by hand against a real Google account, which is why they
 * were the least-covered code in the repo doing the most destructive thing: a bug here silently
 * overwrites or deletes events on the athlete's own calendar, and the app-wins policy means it
 * does so confidently. The two behaviours that most need pinning are the ones a manual test is
 * worst at reproducing — the echo of the app's own write not being mistaken for an external
 * edit, and a genuine simultaneous edit resolving in the app's favour *and leaving a record*.
 *
 * Everything below the googleapis boundary is the real code: calendarClient, push.ts, pull.ts,
 * and a real database. Only Google itself is replaced (see fakeCalendar.ts).
 */
const fake = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("googleapis", () => ({
  google: { calendar: () => (fake.current as { api: () => unknown }).api() },
}));

// getAuthedClient would need a real OAuth token; the connection metadata store is kept in
// memory so ensureRunningCalendar's caching behaves as it does in production.
const metadataStore = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./oauth.js", () => ({
  getAuthedClient: async () => ({}),
  getConnectionMetadata: async () => metadataStore.current,
  setConnectionMetadata: async (_userId: string, meta: Record<string, unknown>) => {
    metadataStore.current = meta;
  },
  isInvalidGrant: () => false,
  markGoogleNeedsReauth: async () => {},
}));

const { FakeGoogleCalendar } = await import("./fakeCalendar.js");
const { db } = await import("../../db/client.js");
const { users, plannedRuns, oauthConnections, syncState, syncConflicts } = await import(
  "../../db/schema.js"
);
const { pushPlannedRunToGoogle, deletePlannedRunFromGoogle } = await import("./push.js");
const { pullGoogleCalendarChanges } = await import("./pull.js");
const { eq, and } = await import("drizzle-orm");

let userId: string;
let calendar: InstanceType<typeof FakeGoogleCalendar>;

async function connectGoogle(overrides: { needsReauth?: boolean } = {}) {
  await db.insert(oauthConnections).values({
    userId,
    provider: "google",
    accessTokenEnc: "enc",
    refreshTokenEnc: "enc",
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ["https://www.googleapis.com/auth/calendar"],
    needsReauth: overrides.needsReauth ?? false,
  });
}

async function addRun(overrides: Partial<typeof plannedRuns.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(plannedRuns)
    .values({
      userId,
      planId: null,
      scheduledAt: new Date("2026-09-15T11:00:00Z"),
      durationMin: 60,
      distanceM: 10_000,
      runType: "tempo",
      origin: "manual",
      ...overrides,
    })
    .returning({ id: plannedRuns.id });
  return row!.id;
}

async function readRun(id: string) {
  const [row] = await db.select().from(plannedRuns).where(eq(plannedRuns.id, id));
  return row;
}

async function conflictsFor(runId: string) {
  return db.select().from(syncConflicts).where(eq(syncConflicts.plannedRunId, runId));
}

async function googleState() {
  const [row] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google")));
  return row;
}

/** Mark the run as edited by the app *after* the last sync — the precondition for a conflict. */
async function touchRunAfterSync(runId: string) {
  const state = await googleState();
  const after = new Date((state?.updatedAt?.getTime() ?? Date.now()) + 60_000);
  await db.update(plannedRuns).set({ updatedAt: after }).where(eq(plannedRuns.id, runId));
}

beforeEach(async () => {
  calendar = new FakeGoogleCalendar();
  fake.current = calendar;
  metadataStore.current = {};

  const [user] = await db
    .insert(users)
    .values({
      email: `gsync-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      timezone: "America/New_York",
      entitlementSource: "comp" as const,
      entitlementStatus: "active" as const,
    })
    .returning({ id: users.id });
  userId = user!.id;
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("push", () => {
  it("creates the event and records its id and etag", async () => {
    await connectGoogle();
    const runId = await addRun();

    await pushPlannedRunToGoogle(runId, userId);

    const run = await readRun(runId);
    expect(run?.gcalEventId).toBeTruthy();
    expect(run?.gcalEtag).toBeTruthy();
    // The stored etag has to be Google's current one, or the very next pull mistakes our own
    // write for someone else's edit.
    expect(calendar.get(run!.gcalEventId!)?.etag).toBe(run?.gcalEtag);
  });

  it("tags the event so a pull can map it back to the run", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);

    const run = await readRun(runId);
    const event = calendar.get(run!.gcalEventId!);
    expect(event?.extendedProperties?.private?.runFarPlannedRunId).toBe(runId);
  });

  it("updates in place on a second push rather than creating a duplicate", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    const first = await readRun(runId);

    await db
      .update(plannedRuns)
      .set({ scheduledAt: new Date("2026-09-15T13:00:00Z") })
      .where(eq(plannedRuns.id, runId));
    await pushPlannedRunToGoogle(runId, userId);

    const second = await readRun(runId);
    expect(second?.gcalEventId).toBe(first?.gcalEventId);
    expect(second?.gcalEtag).not.toBe(first?.gcalEtag);
    expect(calendar.liveEventCount).toBe(1);
  });

  it("sends If-Match so a stale write is refused rather than silently clobbering", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);

    const update = calendar.calls.find((c) => c.method === "events.update");
    expect(update).toBeUndefined(); // first push inserts

    await pushPlannedRunToGoogle(runId, userId);
    const second = calendar.calls.find((c) => c.method === "events.update");
    expect((second?.args as { headers?: Record<string, string> }).headers?.["If-Match"]).toBeTruthy();
  });

  it("forces the overwrite and logs the conflict when the etag is stale", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    const before = await readRun(runId);

    // Someone edits the event in Google. Our stored etag is now stale, so the next If-Match
    // write gets a 412.
    calendar.externallyEdit(before!.gcalEventId!, { summary: "Coffee with Dad" });

    await pushPlannedRunToGoogle(runId, userId);

    // App-wins: the athlete's app-side version is what survives.
    const event = calendar.get(before!.gcalEventId!);
    expect(event?.summary).toBe("Tempo run");
    // And the overwrite is on the record, which is the whole point of the policy being
    // "app wins loudly" rather than "app wins silently".
    expect(await conflictsFor(runId)).toHaveLength(1);
    const after = await readRun(runId);
    expect(after?.gcalEtag).toBe(event?.etag);
  });

  it("never pushes a rest day, and removes one pushed before that rule existed", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    const eventId = (await readRun(runId))!.gcalEventId!;

    await db.update(plannedRuns).set({ runType: "rest" }).where(eq(plannedRuns.id, runId));
    await pushPlannedRunToGoogle(runId, userId);

    expect(calendar.get(eventId)?.status).toBe("cancelled");
    const run = await readRun(runId);
    expect(run?.gcalEventId).toBeNull();
    expect(run?.gcalEtag).toBeNull();
  });

  it("does nothing when Google is not connected", async () => {
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);

    expect(calendar.calls).toHaveLength(0);
    expect((await readRun(runId))?.gcalEventId).toBeNull();
  });

  it("treats a connection flagged needs-reauth as disconnected", async () => {
    await connectGoogle({ needsReauth: true });
    const runId = await addRun();

    await pushPlannedRunToGoogle(runId, userId);

    // The row exists but its refresh token is dead — pushing would fail on every call.
    expect(calendar.calls).toHaveLength(0);
  });

  it("tolerates deleting an event Google has already lost", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    const eventId = (await readRun(runId))!.gcalEventId!;
    calendar.externallyDelete(eventId);

    // A 410 here means the desired end state already holds; failing would strand the app-side
    // delete behind an error.
    await expect(deletePlannedRunFromGoogle(eventId, userId)).resolves.toBeUndefined();
  });
});

describe("pull", () => {
  it("ignores the echo of our own push", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    const before = await readRun(runId);

    await pullGoogleCalendarChanges(userId);

    // The event we just wrote comes back in the very first delta. Treating it as an external
    // edit is how a two-way sync turns into an infinite loop.
    const after = await readRun(runId);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(after?.status).toBe("planned");
  });

  it("applies an external time change and marks the run moved", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    await pullGoogleCalendarChanges(userId);

    const eventId = (await readRun(runId))!.gcalEventId!;
    calendar.externallyEdit(eventId, {
      start: { dateTime: "2026-09-15T15:00:00Z" },
      end: { dateTime: "2026-09-15T16:00:00Z" },
    });

    await pullGoogleCalendarChanges(userId);

    const run = await readRun(runId);
    expect(run?.scheduledAt.toISOString()).toBe("2026-09-15T15:00:00.000Z");
    expect(run?.durationMin).toBe(60);
    expect(run?.status).toBe("moved");
  });

  it("deletes the run when the event is deleted in Google", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    await pullGoogleCalendarChanges(userId);

    calendar.externallyDelete((await readRun(runId))!.gcalEventId!);
    await pullGoogleCalendarChanges(userId);

    expect(await readRun(runId)).toBeUndefined();
  });

  it("keeps and re-pushes a run the app edited but Google deleted", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    await pullGoogleCalendarChanges(userId);
    const eventId = (await readRun(runId))!.gcalEventId!;

    calendar.externallyDelete(eventId);
    await touchRunAfterSync(runId);

    await pullGoogleCalendarChanges(userId);

    // App wins: the session the athlete edited in the app is not silently destroyed by a
    // deletion on the calendar side, and it exists on the calendar again afterwards.
    const run = await readRun(runId);
    expect(run).toBeDefined();
    // A recreated event, not the resurrected corpse of the deleted one — Google will not let
    // you update a deleted event, so the run is now pointing at a new id.
    expect(run?.gcalEventId).not.toBe(eventId);
    expect(calendar.get(run!.gcalEventId!)?.status).toBe("confirmed");
    expect(await conflictsFor(runId)).toHaveLength(1);
  });

  it("keeps the app's version when both sides changed, and records what it overwrote", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    await pullGoogleCalendarChanges(userId);
    const eventId = (await readRun(runId))!.gcalEventId!;

    calendar.externallyEdit(eventId, {
      start: { dateTime: "2026-09-15T20:00:00Z" },
      end: { dateTime: "2026-09-15T21:00:00Z" },
    });
    await touchRunAfterSync(runId);

    await pullGoogleCalendarChanges(userId);

    const run = await readRun(runId);
    // The Google-side time is discarded, not merged.
    expect(run?.scheduledAt.toISOString()).toBe("2026-09-15T11:00:00.000Z");
    expect(calendar.get(eventId)?.start?.dateTime).toBe("2026-09-15T11:00:00.000Z");

    const [conflict] = await conflictsFor(runId);
    expect(conflict?.resolution).toBe("app_won");
    // Both sides retained: an app-wins policy is only defensible if what it discarded is
    // recoverable afterwards.
    expect(conflict?.appVersion).toBeTruthy();
    expect(conflict?.gcalVersion).toBeTruthy();
  });

  it("adopts an event created directly in the Running calendar", async () => {
    await connectGoogle();
    // Establish the calendar and a sync token first.
    await addRun().then((id) => pushPlannedRunToGoogle(id, userId));
    await pullGoogleCalendarChanges(userId);
    const calendarId = (metadataStore.current as { calendarId: string }).calendarId;

    calendar.externallyCreate(calendarId, {
      id: "outside-1",
      summary: "Long run with the club",
      start: { dateTime: "2026-09-20T12:00:00Z" },
      end: { dateTime: "2026-09-20T14:00:00Z" },
    });

    await pullGoogleCalendarChanges(userId);

    const [adopted] = await db
      .select()
      .from(plannedRuns)
      .where(and(eq(plannedRuns.userId, userId), eq(plannedRuns.gcalEventId, "outside-1")));
    expect(adopted).toBeDefined();
    expect(adopted?.runType).toBe("long"); // guessed from the summary
    expect(adopted?.durationMin).toBe(120);
    expect(adopted?.origin).toBe("manual");
  });

  it("stores the sync token and asks for a delta next time", async () => {
    await connectGoogle();
    await pullGoogleCalendarChanges(userId);
    const token = (await googleState())?.syncToken;
    expect(token).toBeTruthy();

    await pullGoogleCalendarChanges(userId);

    const listCalls = calendar.calls.filter((c) => c.method === "events.list");
    // Without this the app re-reads the entire calendar on every webhook and every dashboard
    // sync, which is both slow and how you exhaust a Google quota.
    expect((listCalls[listCalls.length - 1]!.args as { syncToken?: string }).syncToken).toBe(token);
  });

  it("recovers from an expired sync token with a full resync", async () => {
    await connectGoogle();
    const runId = await addRun();
    await pushPlannedRunToGoogle(runId, userId);
    await pullGoogleCalendarChanges(userId);

    const staleToken = (await googleState())!.syncToken!;
    calendar.expireToken(staleToken);
    const callsBefore = calendar.calls.length;

    await pullGoogleCalendarChanges(userId);

    // Google expires sync tokens on its own schedule; a 410 has to self-heal or sync stops
    // permanently for that athlete with nothing but a log line to say so. The recovery is a
    // *full* list — asserting on the token value instead would only be testing the fake, whose
    // tokens are a version counter that doesn't move when nothing changed.
    const after = calendar.calls.slice(callsBefore).filter((c) => c.method === "events.list");
    expect(after.some((c) => (c.args as { syncToken?: string }).syncToken === staleToken)).toBe(true);
    expect(after.some((c) => (c.args as { syncToken?: string }).syncToken == null)).toBe(true);
    expect((await googleState())?.syncToken).toBeTruthy();
  });

  it("follows pagination to the end before storing the sync token", async () => {
    await connectGoogle();
    calendar = new FakeGoogleCalendar({ pageSize: 2 });
    fake.current = calendar;
    metadataStore.current = {};

    for (let i = 0; i < 5; i++) {
      calendar.externallyCreate("cal-1", {
        id: `bulk-${i}`,
        summary: "Easy run",
        start: { dateTime: `2026-09-2${i}T12:00:00Z` },
        end: { dateTime: `2026-09-2${i}T13:00:00Z` },
      });
    }

    await pullGoogleCalendarChanges(userId);

    const adopted = await db.select().from(plannedRuns).where(eq(plannedRuns.userId, userId));
    // Stopping at the first page would silently drop events, and storing that page's token
    // would mean never asking for the rest.
    expect(adopted).toHaveLength(5);
    expect((await googleState())?.syncToken).toBeTruthy();
  });

  it("ignores an event with no start time rather than writing a broken run", async () => {
    await connectGoogle();
    await pullGoogleCalendarChanges(userId);
    calendar.externallyCreate("cal-1", { id: "no-start", summary: "Placeholder" });

    await pullGoogleCalendarChanges(userId);

    expect(await db.select().from(plannedRuns).where(eq(plannedRuns.userId, userId))).toHaveLength(0);
  });
});
