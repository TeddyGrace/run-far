import "dotenv/config";
import { db, pool } from "./client.js";
import { users, recoveryMetrics, sleepRecords, workouts, cycles, plannedRuns, syncState } from "./schema.js";
import { eq } from "drizzle-orm";
import { hashPassword } from "../lib/auth.js";
import { env } from "../env.js";
import { offsetStringForZone } from "../lib/zonedTime.js";
import { reconcileUserSafe } from "../reconciliation/service.js";

const SEED_EMAIL = "dev@run-far.local";
const SEED_PASSWORD = "devpassword123";

function isoDate(daysFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

function atHour(daysFromToday: number, hour: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

async function main() {
  let [user] = await db.select().from(users).where(eq(users.email, SEED_EMAIL));
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email: SEED_EMAIL,
        passwordHash: await hashPassword(SEED_PASSWORD),
        emailVerifiedAt: new Date(),
        approvedAt: new Date(),
        signupSource: "password",
        timezone: env.ATHLETE_TIMEZONE,
      })
      .returning();
  }
  if (!user) throw new Error("failed to create seed user");
  const userId = user.id;

  // Last 7 days of cycles, recovery, sleep, and a few completed workouts. Cycles are
  // wake-to-wake (not calendar-day), so this gives every day a real cycle a snapshot's
  // strain/load aggregation can read — mirroring what a real Whoop sync produces, unlike the
  // old one-fake-cycle-per-calendar-date seed that never exercised the cycle-based paths.
  const seedTzOffset = offsetStringForZone(env.ATHLETE_TIMEZONE);
  for (let i = -6; i <= 0; i++) {
    const date = isoDate(i);
    const externalId = `seed-cycle-${date}`;
    const cycleStrain = 6 + Math.random() * 12; // 0-21 scale
    const cycleKilojoule = 4000 + Math.random() * 4000;

    await db
      .insert(cycles)
      .values({
        userId,
        externalId,
        start: atHour(i, 7),
        end: i < 0 ? atHour(i + 1, 7) : null, // today's cycle is still open
        timezoneOffset: seedTzOffset,
        scoreState: "SCORED",
        strain: cycleStrain,
        kilojoule: cycleKilojoule,
        avgHr: 60 + Math.round(Math.random() * 10),
        maxHr: 150 + Math.round(Math.random() * 20),
      })
      .onConflictDoNothing();

    const recoveryScore = 40 + Math.round(Math.random() * 45);
    await db
      .insert(recoveryMetrics)
      .values({
        userId,
        externalId: `seed-sleep-${date}`,
        cycleId: externalId,
        date,
        recoveryScore,
        hrvRmssdMs: 45 + Math.random() * 20,
        restingHr: 48 + Math.random() * 8,
        spo2: 96 + Math.random() * 2,
        skinTempC: 33 + Math.random(),
        scoreState: "SCORED",
      })
      .onConflictDoNothing();

    await db
      .insert(sleepRecords)
      .values({
        userId,
        externalId: `seed-sleep-${date}`,
        cycleId: externalId,
        nap: false,
        date,
        durationMin: 380 + Math.random() * 90,
        efficiencyPct: 80 + Math.random() * 15,
        performancePct: 70 + Math.random() * 28,
        sleepDebtMin: Math.random() * 60,
        respiratoryRate: 14 + Math.random() * 2,
      })
      .onConflictDoNothing();

    if (i % 2 === 0) {
      await db
        .insert(workouts)
        .values({
          userId,
          externalId: `seed-workout-${date}`,
          date,
          startedAt: atHour(i, 6 + Math.floor(Math.random() * 4)),
          durationMin: 30 + Math.random() * 60,
          sport: "running",
          strain: 8 + Math.random() * 10,
          avgHr: 140 + Math.random() * 20,
          maxHr: 165 + Math.random() * 15,
          kilojoules: 1500 + Math.random() * 1500,
          distanceM: 5000 + Math.random() * 10000,
          percentRecorded: 100,
          altitudeGainM: 20 + Math.random() * 80,
          zoneDurations: {
            zone_zero_milli: 120_000,
            zone_one_milli: 300_000,
            zone_two_milli: 600_000,
            zone_three_milli: 900_000,
            zone_four_milli: 400_000,
            zone_five_milli: 180_000,
          },
        })
        .onConflictDoNothing();
    }
  }

  // Two weeks of planned runs, half of them already behind the athlete.
  //
  // The past half exists so the reconciliation sweep has something to decide and the adherence
  // panel has something to show on a fresh database, before any integration is connected. Its
  // shape is chosen against the seeded workouts above (which land on even offsets): day -6 and
  // -2 have a workout and reconcile as completed, -5 and -1 have none and reconcile as missed,
  // and -4 carries a workout with no planned run at all — which is what puts a real "you ran
  // this a day late, did it count?" correction in front of the panel's fix control.
  const pastPlan = [
    { day: -6, hour: 6, type: "easy" as const, dist: 8000, dur: 45, desc: "Easy aerobic run" },
    { day: -5, hour: 6, type: "tempo" as const, dist: 10000, dur: 50, desc: "Tempo: 4x1600m" },
    { day: -3, hour: 6, type: "rest" as const, dist: 0, dur: 0, desc: "Rest day" },
    { day: -2, hour: 6, type: "easy" as const, dist: 6000, dur: 35, desc: "Recovery jog" },
    { day: -1, hour: 8, type: "long" as const, dist: 18000, dur: 95, desc: "Long run, easy pace" },
  ];

  // A week of planned runs: today through +6 days.
  const plan = [
    { day: 0, hour: 6, type: "easy" as const, dist: 8000, dur: 45, desc: "Easy aerobic run" },
    { day: 1, hour: 6, type: "rest" as const, dist: 0, dur: 0, desc: "Rest day" },
    { day: 2, hour: 6, type: "tempo" as const, dist: 10000, dur: 50, desc: "Tempo: 3x2km @ threshold" },
    { day: 3, hour: 6, type: "easy" as const, dist: 6000, dur: 35, desc: "Recovery jog" },
    { day: 4, hour: 6, type: "interval" as const, dist: 9000, dur: 55, desc: "6x800m @ 5k pace" },
    { day: 5, hour: 6, type: "easy" as const, dist: 5000, dur: 30, desc: "Easy shakeout" },
    { day: 6, hour: 8, type: "long" as const, dist: 21000, dur: 110, desc: "Long run, easy pace" },
  ];

  for (const p of [...pastPlan, ...plan]) {
    await db.insert(plannedRuns).values({
      userId,
      planId: null,
      scheduledAt: atHour(p.day, p.hour),
      durationMin: p.dur,
      distanceM: p.dist,
      runType: p.type,
      targetPaceSPerKm: null,
      plannedTss: p.dur, // placeholder TSS ~= duration for seed data
      description: p.desc,
      structure: null,
      status: "planned",
      origin: "manual",
    });
  }

  // The seeded workouts stand in for a real Whoop sync, so record the watermark that sync would
  // have left. Without it the reconciliation sweep correctly refuses to call anything missed —
  // it has no basis for believing it would have seen a workout — and the whole seeded week reads
  // as "not tracked" instead of demonstrating anything.
  await db
    .insert(syncState)
    .values({ userId, provider: "whoop", lastPolledAt: new Date() })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { lastPolledAt: new Date() },
    });

  // Decide the past runs now, so the dashboard's adherence panel is populated on first load
  // rather than waiting for a Whoop webhook that a local dev database will never receive.
  await reconcileUserSafe(userId);

  console.log(
    `Seeded user ${SEED_EMAIL} with 7 days of recovery data and ${pastPlan.length + plan.length} planned runs.`,
  );
  console.log(`Dev login: ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
