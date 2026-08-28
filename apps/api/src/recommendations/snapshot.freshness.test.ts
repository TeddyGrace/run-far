import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_CLIENT_ID ??= "test-client-id";
process.env.WHOOP_CLIENT_SECRET ??= "test-client-secret";

// Stub the Whoop sync so the on-read refresh never touches the real API. The implementation is
// set per-test to simulate what a live re-fetch would upsert.
const { syncSingleResource } = vi.hoisted(() => ({ syncSingleResource: vi.fn() }));
vi.mock("../integrations/whoop/sync.js", () => ({ syncSingleResource }));

const { db } = await import("../db/client.js");
const { users, sleepRecords } = await import("../db/schema.js");
const { buildRecoverySnapshot } = await import("./snapshot.js");
const { and, eq } = await import("drizzle-orm");

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    const whoopSleepId = `sleep-stale-${randomUUID()}`;
    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId,
      date: todayIso,
      nap: false,
      sleepDebtMin: 113, // the stale value the athlete disputed
    });
    // Make the row look older than the 10-min TTL.
    await db
      .update(sleepRecords)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.whoopSleepId, whoopSleepId)));

    // Simulate Whoop's live re-score landing via the idempotent upsert.
    syncSingleResource.mockImplementation(async () => {
      await db
        .update(sleepRecords)
        .set({ sleepDebtMin: 61, updatedAt: new Date() })
        .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.whoopSleepId, whoopSleepId)));
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(syncSingleResource).toHaveBeenCalledWith(userId, "sleep", whoopSleepId);
    expect(snapshot.sleepDebtMinToday).toBe(61);
  });

  it("does not re-fetch when today's stored row is within the freshness TTL", async () => {
    const todayIso = isoDate(new Date());
    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId: `sleep-fresh-${randomUUID()}`,
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
    const whoopSleepId = `sleep-err-${randomUUID()}`;
    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId,
      date: todayIso,
      nap: false,
      sleepDebtMin: 113,
    });
    await db
      .update(sleepRecords)
      .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.whoopSleepId, whoopSleepId)));

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
      whoopSleepId: `sleep-nap-${randomUUID()}`,
      date: todayIso,
      nap: true,
      sleepDebtMin: 9999, // must never be picked
    });
    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId: `sleep-main-${randomUUID()}`,
      date: todayIso,
      nap: false,
      sleepDebtMin: 61,
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(syncSingleResource).not.toHaveBeenCalled();
    expect(snapshot.sleepDebtMinToday).toBe(61);
  });
});
