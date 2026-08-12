import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_CLIENT_ID ??= "test-client-id";
process.env.WHOOP_CLIENT_SECRET ??= "test-client-secret";

const { db } = await import("../db/client.js");
const { users, cycles, sleepRecords } = await import("../db/schema.js");
const { buildRecoverySnapshot } = await import("./snapshot.js");
const { eq } = await import("drizzle-orm");

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

let userId: string;

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `snapshot-test-${randomUUID()}@run-far.local`, passwordHash: "x" })
    .returning({ id: users.id });
  userId = user!.id;
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("buildRecoverySnapshot sleep debt (cycle-aware 'today')", () => {
  it("picks the main sleep's debt, not a nap's, when both share today's cycle", async () => {
    const todayIso = isoDate(new Date());
    await db.insert(cycles).values({
      userId,
      whoopCycleId: `cycle-${randomUUID()}`,
      start: new Date(),
      end: null,
    });
    const [cycleRow] = await db.select().from(cycles).where(eq(cycles.userId, userId));
    const whoopCycleId = cycleRow!.whoopCycleId;

    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId: `sleep-main-${randomUUID()}`,
      cycleId: whoopCycleId,
      nap: false,
      date: todayIso,
      sleepDebtMin: 107, // 1h47m — the value that should win
    });
    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId: `sleep-nap-${randomUUID()}`,
      cycleId: whoopCycleId,
      nap: true,
      date: todayIso,
      sleepDebtMin: 9999, // deliberately wrong — must never be picked
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.sleepDebtMinToday).toBe(107);
  });

  it("resolves via cycleId even when the main sleep's date doesn't match today's UTC date", async () => {
    const yesterdayIso = isoDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await db.insert(cycles).values({
      userId,
      whoopCycleId: `cycle-${randomUUID()}`,
      start: new Date(),
      end: null,
    });
    const [cycleRow] = await db.select().from(cycles).where(eq(cycles.userId, userId));
    const whoopCycleId = cycleRow!.whoopCycleId;

    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId: `sleep-main-${randomUUID()}`,
      cycleId: whoopCycleId,
      nap: false,
      date: yesterdayIso, // sleep started before UTC midnight, but it's still the current cycle
      sleepDebtMin: 62,
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.sleepDebtMinToday).toBe(62);
  });

  it("falls back to a plain date match when no cycles have synced yet", async () => {
    const todayIso = isoDate(new Date());
    await db.insert(sleepRecords).values({
      userId,
      whoopSleepId: `sleep-main-${randomUUID()}`,
      date: todayIso,
      sleepDebtMin: 30,
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.sleepDebtMinToday).toBe(30);
  });
});
