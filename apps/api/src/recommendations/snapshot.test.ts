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
const { strainToLoad } = await import("../metrics/cycleMetrics.js");
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** A completed cycle `daysAgo` days back, 24h long, with the given score fields. */
async function insertCompletedCycle(
  userId: string,
  daysAgo: number,
  fields: { strain?: number | null; kilojoule?: number | null },
): Promise<void> {
  const start = new Date(Date.now() - daysAgo * DAY_MS);
  const end = new Date(start.getTime() + DAY_MS);
  await db.insert(cycles).values({
    userId,
    whoopCycleId: `cycle-completed-${randomUUID()}`,
    start,
    end,
    strain: fields.strain ?? null,
    kilojoule: fields.kilojoule ?? null,
  });
}

describe("buildRecoverySnapshot cycle strain/load aggregation", () => {
  it("excludes the open (still-accumulating) cycle from the 7-cycle rolling window", async () => {
    for (let i = 1; i <= 7; i++) {
      await insertCompletedCycle(userId, i, { strain: 10, kilojoule: 4000 });
    }
    // The current cycle is open (end: null) and would otherwise drag the mean toward its
    // still-accumulating (necessarily lower) strain.
    await db.insert(cycles).values({
      userId,
      whoopCycleId: `cycle-open-${randomUUID()}`,
      start: new Date(),
      end: null,
      strain: 2,
      kilojoule: 300,
    });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.cyclesCounted7d).toBe(7);
    expect(snapshot.cycleStrainAvg7d).toBe(10);
  });

  it("reports an honest denominator when fewer than 7 completed cycles have synced", async () => {
    await insertCompletedCycle(userId, 1, { strain: 12, kilojoule: 5000 });
    await insertCompletedCycle(userId, 2, { strain: 8, kilojoule: 3000 });
    await insertCompletedCycle(userId, 3, { strain: 10, kilojoule: 4000 });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.cyclesCounted7d).toBe(3);
    expect(snapshot.cycleStrainAvg7d).toBeCloseTo(10, 5);
  });

  it("falls back to the strain-derived load approximation when a cycle has no kilojoule reading", async () => {
    await insertCompletedCycle(userId, 1, { strain: 15, kilojoule: null });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.cycleLoadSum7d).toBeCloseTo(strainToLoad(15), 5);
  });

  it("sums real kilojoule readings directly rather than approximating them", async () => {
    await insertCompletedCycle(userId, 1, { strain: 10, kilojoule: 4000 });
    await insertCompletedCycle(userId, 2, { strain: 12, kilojoule: 5000 });

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.cycleLoadSum7d).toBeCloseTo(9000, 5);
  });
});
