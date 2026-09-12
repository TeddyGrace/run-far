import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

const { db } = await import("../../db/client.js");
const { users, recoveryMetrics, sleepRecords, cycles, workouts, syncState } = await import(
  "../../db/schema.js"
);
const { ingestAppleHealth } = await import("./ingest.js");
const { appleHealthIngestSchema } = await import("@run-far/shared");
const { getActiveHealthProvider } = await import("../../lib/healthProvider.js");
const { buildRecoverySnapshot } = await import("../../recommendations/snapshot.js");
const { and, eq, inArray } = await import("drizzle-orm");

const TZ = "America/New_York";

/**
 * End-to-end coverage of the one integration whose data arrives by being pushed to us.
 *
 * The cases that matter here are the ones a unit test can't reach: that a replayed batch is a
 * no-op (the app retries, and its HealthKit anchor windows overlap by design), that derived
 * values are re-derived from the database rather than patched from the batch, and that an
 * athlete's Whoop history is untouched and unread while Apple Health is active.
 */
describe("ingestAppleHealth", () => {
  let userIds: string[] = [];

  afterEach(async () => {
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    userIds = [];
  });

  async function seedUser(provider: "whoop" | "apple_health" = "apple_health") {
    const [row] = await db
      .insert(users)
      .values({
        email: `apple-ingest-${randomUUID()}@run-far.local`,
        emailVerifiedAt: new Date(),
        entitlementSource: "comp",
        entitlementStatus: "active",
        timezone: TZ,
        activeHealthProvider: provider,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed user");
    userIds.push(row.id);
    return row.id;
  }

  /**
   * A run of nights ending `nightCount-1..0` days before `now`.
   *
   * The readings carry small deterministic night-to-night variation rather than being constant,
   * because constant readings have a zero standard deviation and the scorer correctly refuses
   * to score a deviation against one (see sampleStats) — a flat fixture would test nothing but
   * that guard. The variation is a fixed pattern, not random, so the expected scores are stable.
   */
  function buildPayload(
    now: Date,
    nightCount: number,
    overrides: {
      hrvOn?: Record<number, number>;
      asleepOn?: Record<number, number>;
      /** Every reading identical across every night — a degenerate series with a zero SD. */
      flat?: boolean;
    } = {},
  ) {
    const sleepSessions = [];
    for (let i = nightCount - 1; i >= 0; i--) {
      const wake = new Date(now.getTime() - i * 86_400_000);
      wake.setUTCHours(11, 0, 0, 0);
      const start = new Date(wake.getTime() - 8 * 3_600_000);
      sleepSessions.push({
        externalId: `sleep-${i}`,
        startedAt: start.toISOString(),
        endedAt: wake.toISOString(),
        asleepMin: overrides.asleepOn?.[i] ?? (overrides.flat ? 460 : 455 + ((i * 7) % 11)),
        inBedMin: 480,
        lightMin: 240,
        deepMin: 100,
        remMin: 120,
        awakeMin: 20,
        hrvSdnnMs: overrides.hrvOn?.[i] ?? (overrides.flat ? 60 : 56 + ((i * 5) % 9)),
        restingHr: overrides.flat ? 50 : 48 + ((i * 3) % 5),
        respiratoryRate: overrides.flat ? 14 : 13.6 + ((i * 2) % 5) * 0.2,
        oxygenSaturationPct: 97,
        wristTempC: overrides.flat ? 33 : 32.8 + ((i * 4) % 5) * 0.1,
      });
    }
    return appleHealthIngestSchema.parse({
      device: { model: "iPhone 15 Pro", timeZone: TZ },
      coveredThrough: now.toISOString(),
      sleepSessions,
      workouts: [],
    });
  }

  it("stores sleep, cycles and a recovery row per night", async () => {
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const result = await ingestAppleHealth(userId, buildPayload(now, 20), { now });

    expect(result.sleepSessions).toBe(20);
    expect(result.cycles).toBe(20);
    expect(result.recoveryRows).toBe(20);

    const sleepRows = await db
      .select()
      .from(sleepRecords)
      .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.provider, "apple_health")));
    expect(sleepRows).toHaveLength(20);
    // Every row is attributed to the provider that sent it, and its HRV to the metric Apple
    // actually reports — the two facts the provider seam exists to keep straight.
    const recoveryRows = await db
      .select()
      .from(recoveryMetrics)
      .where(and(eq(recoveryMetrics.userId, userId), eq(recoveryMetrics.provider, "apple_health")));
    expect(recoveryRows.every((r) => r.hrvMetric === "sdnn")).toBe(true);
    expect(recoveryRows.every((r) => r.recoveryScoreSource === "derived")).toBe(true);
  });

  it("withholds a score until enough baseline exists, then scores", async () => {
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");

    const thin = await ingestAppleHealth(userId, buildPayload(now, 5), { now });
    expect(thin.recoveryScored).toBe(0);
    expect(thin.baselineDays).toBeLessThan(thin.baselineDaysRequired);

    const full = await ingestAppleHealth(userId, buildPayload(now, 25), { now });
    expect(full.recoveryScored).toBeGreaterThan(0);
    expect(full.baselineDays).toBeGreaterThanOrEqual(full.baselineDaysRequired);
  });

  it("withholds a score when every reading is identical", async () => {
    // A perfectly flat series has a zero SD, which cannot scale a deviation into a z-score. The
    // honest answer is no score rather than a divide-by-zero or a fabricated 100.
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const result = await ingestAppleHealth(userId, buildPayload(now, 25, { flat: true }), { now });
    // Plenty of history — this is not the baseline-length guard — but nothing in it varies, so
    // there is no spread to measure a deviation against.
    expect(result.baselineDays).toBeGreaterThanOrEqual(result.baselineDaysRequired);
    expect(result.recoveryScored).toBe(0);
  });

  it("is a no-op when the same batch is replayed", async () => {
    // The app retries and its anchor windows overlap, so this is the normal case, not an edge.
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const payload = buildPayload(now, 20);

    await ingestAppleHealth(userId, payload, { now });
    const before = await snapshotCounts(userId);
    await ingestAppleHealth(userId, payload, { now });
    const after = await snapshotCounts(userId);

    expect(after).toEqual(before);
  });

  it("re-derives earlier scores as new nights move the baseline", async () => {
    // A score is a statement about a night relative to the nights around it. If ingest patched
    // only the batch, the dashboard would show old scores measured against a baseline that no
    // longer exists.
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");

    // Twenty ordinary nights, then the same twenty with a run of much higher HRV added on top,
    // which lifts the baseline mean and so must lower the older nights' scores.
    await ingestAppleHealth(userId, buildPayload(now, 20), { now });
    const [earlyRow] = await db
      .select({ score: recoveryMetrics.recoveryScore })
      .from(recoveryMetrics)
      .where(
        and(
          eq(recoveryMetrics.userId, userId),
          eq(recoveryMetrics.provider, "apple_health"),
          eq(recoveryMetrics.externalId, "sleep-0"),
        ),
      );

    // Raised, but still varying: a constant 90 would itself be a degenerate zero-SD baseline
    // and the HRV component would drop out entirely rather than reading as "well above normal".
    const raised: Record<number, number> = {};
    for (let i = 1; i <= 19; i++) raised[i] = 88 + ((i * 5) % 7);
    await ingestAppleHealth(userId, buildPayload(now, 20, { hrvOn: raised }), { now });

    const [rescored] = await db
      .select({ score: recoveryMetrics.recoveryScore })
      .from(recoveryMetrics)
      .where(
        and(
          eq(recoveryMetrics.userId, userId),
          eq(recoveryMetrics.provider, "apple_health"),
          eq(recoveryMetrics.externalId, "sleep-0"),
        ),
      );

    expect(earlyRow?.score).not.toBeNull();
    expect(rescored?.score).toBeLessThan(earlyRow!.score!);
  });

  it("classifies a nap as a nap and does not let it become the night", async () => {
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const payload = buildPayload(now, 3);
    payload.sleepSessions.push({
      externalId: "afternoon-doze",
      startedAt: "2026-09-12T18:30:00Z",
      endedAt: "2026-09-12T19:00:00Z",
      asleepMin: 30,
      inBedMin: null,
      lightMin: null,
      deepMin: null,
      remMin: null,
      awakeMin: null,
      hrvSdnnMs: null,
      restingHr: null,
      respiratoryRate: null,
      oxygenSaturationPct: null,
      wristTempC: null,
    });

    await ingestAppleHealth(userId, payload, { now });

    const [doze] = await db
      .select({ nap: sleepRecords.nap })
      .from(sleepRecords)
      .where(
        and(
          eq(sleepRecords.userId, userId),
          eq(sleepRecords.provider, "apple_health"),
          eq(sleepRecords.externalId, "afternoon-doze"),
        ),
      );
    expect(doze?.nap).toBe(true);
  });

  it("maps an indoor run to treadmill_running so it still counts as a run", async () => {
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const payload = buildPayload(now, 2);
    payload.workouts.push(
      {
        externalId: "outdoor-run",
        activityType: "running",
        indoor: false,
        startedAt: "2026-09-12T13:00:00Z",
        endedAt: "2026-09-12T14:00:00Z",
        durationMin: 60,
        distanceM: 12000,
        activeEnergyKj: 3000,
        avgHr: 145,
        maxHr: 172,
        elevationAscendedM: 80,
      },
      {
        externalId: "treadmill-run",
        activityType: "running",
        indoor: true,
        startedAt: "2026-09-11T13:00:00Z",
        endedAt: "2026-09-11T13:40:00Z",
        durationMin: 40,
        // No GPS indoors — the case the manual-distance path exists for.
        distanceM: null,
        activeEnergyKj: 1800,
        avgHr: 140,
        maxHr: 160,
        elevationAscendedM: null,
      },
    );

    await ingestAppleHealth(userId, payload, { now });

    const rows = await db
      .select({ externalId: workouts.externalId, sport: workouts.sport, strain: workouts.strain })
      .from(workouts)
      .where(and(eq(workouts.userId, userId), eq(workouts.provider, "apple_health")));
    const byId = new Map(rows.map((r) => [r.externalId, r]));
    expect(byId.get("outdoor-run")?.sport).toBe("running");
    expect(byId.get("treadmill-run")?.sport).toBe("treadmill_running");
    // Apple publishes no strain equivalent; load rides on kilojoules instead.
    expect(rows.every((r) => r.strain === null)).toBe(true);
  });

  it("never lets a later null distance clobber a hand-entered one", async () => {
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const payload = buildPayload(now, 2);
    const treadmill = {
      externalId: "treadmill-run",
      activityType: "running",
      indoor: true,
      startedAt: "2026-09-12T13:00:00Z",
      endedAt: "2026-09-12T13:40:00Z",
      durationMin: 40,
      distanceM: null,
      activeEnergyKj: 1800,
      avgHr: 140,
      maxHr: 160,
      elevationAscendedM: null,
    };
    payload.workouts.push(treadmill);
    await ingestAppleHealth(userId, payload, { now });

    // The athlete enters the treadmill's distance by hand.
    await db
      .update(workouts)
      .set({ distanceM: 8000, distanceManual: true })
      .where(
        and(
          eq(workouts.userId, userId),
          eq(workouts.provider, "apple_health"),
          eq(workouts.externalId, "treadmill-run"),
        ),
      );

    // …and the app resyncs the same workout, still with no distance.
    await ingestAppleHealth(userId, payload, { now });

    const [row] = await db
      .select({ distanceM: workouts.distanceM, distanceManual: workouts.distanceManual })
      .from(workouts)
      .where(
        and(
          eq(workouts.userId, userId),
          eq(workouts.provider, "apple_health"),
          eq(workouts.externalId, "treadmill-run"),
        ),
      );
    expect(row?.distanceM).toBe(8000);
    expect(row?.distanceManual).toBe(true);
  });

  it("writes the sync watermark, clamped so a skewed device clock can't claim future coverage", async () => {
    // The reconciliation sweep reads this to decide whether an absence of workouts means an
    // absence of running. A watermark ahead of real time would assert coverage over days no
    // data could have reached us for, and the sweep would mark real sessions missed.
    const userId = await seedUser();
    const now = new Date("2026-09-12T18:00:00Z");
    const payload = buildPayload(now, 2);
    payload.coveredThrough = "2027-01-01T00:00:00.000Z";

    await ingestAppleHealth(userId, payload, { now });

    const [state] = await db
      .select({ lastPolledAt: syncState.lastPolledAt })
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.provider, "apple_health")));
    expect(state?.lastPolledAt?.toISOString()).toBe(now.toISOString());
  });

  it("stores data for an athlete still on Whoop without it being read", async () => {
    // An athlete mid-switch should arrive at Apple Health with history already there, rather
    // than an empty dashboard and a 30-day wait for a baseline. The rows are written; the
    // provider filter is what keeps them out of the engine until they switch.
    const userId = await seedUser("whoop");
    const now = new Date("2026-09-12T18:00:00Z");
    await ingestAppleHealth(userId, buildPayload(now, 25), { now });

    expect(await getActiveHealthProvider(userId)).toBe("whoop");

    const snapshot = await buildRecoverySnapshot(userId);
    expect(snapshot.provider).toBe("whoop");
    // Nothing from the Apple rows leaks into a Whoop athlete's snapshot.
    expect(snapshot.recoveryScore).toBeNull();
    expect(snapshot.hrvRmssdMs).toBeNull();
    expect(snapshot.hrvBaselineMs).toBeNull();

    // Switch, and the same data is now what the engine reads.
    await db.update(users).set({ activeHealthProvider: "apple_health" }).where(eq(users.id, userId));
    const afterSwitch = await buildRecoverySnapshot(userId);
    expect(afterSwitch.provider).toBe("apple_health");
    expect(afterSwitch.hrvMetric).toBe("sdnn");
    expect(afterSwitch.recoveryScoreSource).toBe("derived");
    expect(afterSwitch.hrvRmssdMs).not.toBeNull();
  });

  it("keeps a Whoop athlete's own rows untouched while ingesting Apple data", async () => {
    const userId = await seedUser("whoop");
    const now = new Date("2026-09-12T18:00:00Z");

    // A Whoop row for the same night, with an RMSSD reading on a different scale.
    await db.insert(recoveryMetrics).values({
      userId,
      provider: "whoop",
      externalId: "whoop-sleep-1",
      date: "2026-09-12",
      recoveryScore: 41,
      hrvRmssdMs: 33,
      hrvMetric: "rmssd",
      restingHr: 54,
      scoreState: "SCORED",
      recoveryScoreSource: "provider",
    });

    await ingestAppleHealth(userId, buildPayload(now, 20), { now });

    const [whoopRow] = await db
      .select()
      .from(recoveryMetrics)
      .where(
        and(
          eq(recoveryMetrics.userId, userId),
          eq(recoveryMetrics.provider, "whoop"),
          eq(recoveryMetrics.externalId, "whoop-sleep-1"),
        ),
      );
    expect(whoopRow?.recoveryScore).toBe(41);
    expect(whoopRow?.hrvRmssdMs).toBe(33);
    expect(whoopRow?.hrvMetric).toBe("rmssd");
    expect(whoopRow?.recoveryScoreSource).toBe("provider");
  });

  /** Row counts per table for this athlete's Apple Health data — what a replay must not move. */
  async function snapshotCounts(userId: string) {
    const [sleep, recovery, cycleRows, workoutRows] = await Promise.all([
      db
        .select({ id: sleepRecords.id })
        .from(sleepRecords)
        .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.provider, "apple_health"))),
      db
        .select({ id: recoveryMetrics.id })
        .from(recoveryMetrics)
        .where(and(eq(recoveryMetrics.userId, userId), eq(recoveryMetrics.provider, "apple_health"))),
      db
        .select({ id: cycles.id })
        .from(cycles)
        .where(and(eq(cycles.userId, userId), eq(cycles.provider, "apple_health"))),
      db
        .select({ id: workouts.id })
        .from(workouts)
        .where(and(eq(workouts.userId, userId), eq(workouts.provider, "apple_health"))),
    ]);
    return {
      sleep: sleep.length,
      recovery: recovery.length,
      cycles: cycleRows.length,
      workouts: workoutRows.length,
    };
  }
});
