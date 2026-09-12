import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_CLIENT_ID ??= "test-client-id";
process.env.WHOOP_CLIENT_SECRET ??= "test-client-secret";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

// Stub the Whoop sync so the on-read refresh never touches the real API. The implementation is
// set per-test to simulate what a live re-fetch would upsert.
const { syncSingleResource } = vi.hoisted(() => ({ syncSingleResource: vi.fn() }));
vi.mock("../integrations/whoop/sync.js", () => ({ syncSingleResource }));

const { db } = await import("../db/client.js");
const { users, sleepRecords } = await import("../db/schema.js");
const { buildRecoverySnapshot } = await import("./snapshot.js");
const { and, eq } = await import("drizzle-orm");
const { dateYmdInZone } = await import("../lib/zonedTime.js");

/** The date rows are bucketed by is the athlete's *local* calendar date (see
 * getAthleteTimezone), which is not the UTC date for part of every day — so fixtures have to
 * use the same zone the snapshot resolves "today" in, or they land on the wrong date. */
const TZ = process.env.ATHLETE_TIMEZONE!;

function isoDate(d: Date): string {
  return dateYmdInZone(d, TZ);
}

let userId: string;

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `snapshot-fresh-${randomUUID()}@run-far.local`, passwordHash: "x" })
    .returning({ id: users.id });
  userId = user!.id;
  syncSingleResource.mockReset();
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("buildRecoverySnapshot on-read sleep freshness", () => {
  it("re-fetches today's sleep and serves the refreshed debt when the stored row is stale", async () => {
    const todayIso = isoDate(new Date());
    const externalId = `sleep-stale-${randomUUID()}`;
    await db.insert(sleepRecords).values({
      userId,
      externalId,
      date: todayIso,
      nap: false,
      sleepDebtMin: 113, // the stale value the athlete disputed
    });
    // Make the row look older than the 10-min TTL.
    await db
      .update(sleepRecords)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.externalId, externalId)));

    // Simulate Whoop's live re-score landing via the idempotent upsert.
    syncSingleResource.mockImplementation(async () => {
      await db
        .update(sleepRecords)
        .set({ sleepDebtMin: 61, updatedAt: new Date() })
        .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.externalId, externalId)));
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(syncSingleResource).toHaveBeenCalledWith(userId, "sleep", externalId);
    expect(snapshot.sleepDebtMinToday).toBe(61);
  });

  it("does not re-fetch when today's stored row is within the freshness TTL", async () => {
    const todayIso = isoDate(new Date());
    await db.insert(sleepRecords).values({
      userId,
      externalId: `sleep-fresh-${randomUUID()}`,
      date: todayIso,
      nap: false,
      sleepDebtMin: 61,
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(syncSingleResource).not.toHaveBeenCalled();
    expect(snapshot.sleepDebtMinToday).toBe(61);
  });

  it("falls back to the stored value if the on-read refresh throws", async () => {
    const todayIso = isoDate(new Date());
    const externalId = `sleep-err-${randomUUID()}`;
    await db.insert(sleepRecords).values({
      userId,
      externalId,
      date: todayIso,
      nap: false,
      sleepDebtMin: 113,
    });
    await db
      .update(sleepRecords)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.externalId, externalId)));

    syncSingleResource.mockRejectedValue(new Error("whoop down"));

    const snapshot = await buildRecoverySnapshot(userId);
    expect(syncSingleResource).toHaveBeenCalledTimes(1);
    expect(snapshot.sleepDebtMinToday).toBe(113);
  });

  it("never selects a nap row in the no-cycle date fallback", async () => {
    const todayIso = isoDate(new Date());
    // Fresh rows (within TTL) so no refresh fires — this isolates the fallback selection.
    await db.insert(sleepRecords).values({
      userId,
      externalId: `sleep-nap-${randomUUID()}`,
      date: todayIso,
      nap: true,
      sleepDebtMin: 9999, // must never be picked
    });
    await db.insert(sleepRecords).values({
      userId,
      externalId: `sleep-main-${randomUUID()}`,
      date: todayIso,
      nap: false,
      sleepDebtMin: 61,
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(syncSingleResource).not.toHaveBeenCalled();
    expect(snapshot.sleepDebtMinToday).toBe(61);
  });
});
