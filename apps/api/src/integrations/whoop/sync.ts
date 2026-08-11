import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, syncState } from "../../db/schema.js";
import { whoopGet, whoopPaginate } from "./client.js";
import type { WhoopRecovery, WhoopSleep, WhoopWorkout } from "./types.js";
import { logger } from "../../lib/logger.js";

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

async function upsertRecovery(userId: string, r: WhoopRecovery): Promise<void> {
  await db
    .insert(recoveryMetrics)
    .values({
      userId,
      whoopSleepId: r.sleep_id,
      cycleId: String(r.cycle_id),
      date: toDateOnly(r.created_at),
      recoveryScore: r.score?.recovery_score ?? null,
      hrvRmssdMs: r.score?.hrv_rmssd_milli ?? null,
      restingHr: r.score?.resting_heart_rate ?? null,
      spo2: r.score?.spo2_percentage ?? null,
      skinTempC: r.score?.skin_temp_celsius ?? null,
      scoreState: r.score_state,
    })
    .onConflictDoUpdate({
      target: recoveryMetrics.whoopSleepId,
      set: {
        cycleId: String(r.cycle_id),
        recoveryScore: r.score?.recovery_score ?? null,
        hrvRmssdMs: r.score?.hrv_rmssd_milli ?? null,
        restingHr: r.score?.resting_heart_rate ?? null,
        spo2: r.score?.spo2_percentage ?? null,
        skinTempC: r.score?.skin_temp_celsius ?? null,
        scoreState: r.score_state,
        updatedAt: new Date(),
      },
    });
}

async function upsertSleep(userId: string, s: WhoopSleep): Promise<void> {
  const inBedMs = s.score?.stage_summary.total_in_bed_time_milli ?? null;
  const awakeMs = s.score?.stage_summary.total_awake_time_milli ?? null;
  const durationMin = inBedMs != null && awakeMs != null ? (inBedMs - awakeMs) / 60_000 : null;
  const sleepDebtMin = s.score?.sleep_needed.need_from_sleep_debt_milli
    ? s.score.sleep_needed.need_from_sleep_debt_milli / 60_000
    : null;
  const performancePct = s.score?.sleep_performance_percentage ?? null;

  await db
    .insert(sleepRecords)
    .values({
      userId,
      whoopSleepId: s.id,
      date: toDateOnly(s.start),
      durationMin,
      efficiencyPct: s.score?.stage_summary.sleep_efficiency_percentage ?? null,
      performancePct,
      sleepDebtMin,
      respiratoryRate: s.score?.respiratory_rate ?? null,
    })
    .onConflictDoUpdate({
      target: sleepRecords.whoopSleepId,
      set: {
        durationMin,
        efficiencyPct: s.score?.stage_summary.sleep_efficiency_percentage ?? null,
        performancePct,
        sleepDebtMin,
        respiratoryRate: s.score?.respiratory_rate ?? null,
        updatedAt: new Date(),
      },
    });
}

async function upsertWorkout(userId: string, w: WhoopWorkout): Promise<void> {
  const startedAt = new Date(w.start);
  const endedAt = new Date(w.end);
  const durationMin =
    Number.isFinite(startedAt.getTime()) && Number.isFinite(endedAt.getTime())
      ? Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 60_000)
      : null;
  const score = w.score;
  const row = {
    startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : null,
    durationMin,
    sport: w.sport_name ?? null,
    strain: score?.strain ?? null,
    avgHr: score?.average_heart_rate ?? null,
    maxHr: score?.max_heart_rate ?? null,
    kilojoules: score?.kilojoule ?? null,
    distanceM: score?.distance_meter ?? null,
    percentRecorded: score?.percent_recorded ?? null,
    altitudeGainM: score?.altitude_gain_meter ?? null,
    altitudeChangeM: score?.altitude_change_meter ?? null,
    zoneDurations: score?.zone_durations ?? null,
  };

  await db
    .insert(whoopWorkouts)
    .values({
      userId,
      whoopWorkoutId: w.id,
      date: toDateOnly(w.start),
      ...row,
    })
    .onConflictDoUpdate({
      target: whoopWorkouts.whoopWorkoutId,
      set: { ...row, updatedAt: new Date() },
    });
}

/** Full sync of recovery/sleep/workout for a date range. Used for backfill and as a nightly safety net. */
export async function syncWhoopRange(userId: string, start: string, end?: string): Promise<void> {
  let recoveryCount = 0;
  for await (const r of whoopPaginate<WhoopRecovery>(userId, "/v2/recovery", { start, end })) {
    await upsertRecovery(userId, r);
    recoveryCount++;
  }

  let sleepCount = 0;
  for await (const s of whoopPaginate<WhoopSleep>(userId, "/v2/activity/sleep", { start, end })) {
    await upsertSleep(userId, s);
    sleepCount++;
  }

  let workoutCount = 0;
  for await (const w of whoopPaginate<WhoopWorkout>(userId, "/v2/activity/workout", {
    start,
    end,
  })) {
    await upsertWorkout(userId, w);
    workoutCount++;
  }

  await db
    .insert(syncState)
    .values({ userId, provider: "whoop", lastPolledAt: new Date() })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { lastPolledAt: new Date(), updatedAt: new Date() },
    });

  logger.info(
    { userId, recoveryCount, sleepCount, workoutCount, start, end },
    "whoop sync complete",
  );
}

/** Initial backfill: last 90 days. Call once after a user first connects Whoop. */
export async function backfillWhoop(userId: string): Promise<void> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 90);
  await syncWhoopRange(userId, start.toISOString());
}

/** Incremental sync from the stored watermark; falls back to a 7-day window if none exists. */
export async function incrementalSyncWhoop(userId: string): Promise<void> {
  const [state] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "whoop")));

  const start = state?.lastPolledAt
    ? new Date(state.lastPolledAt.getTime() - 24 * 60 * 60 * 1000) // 1-day overlap for safety
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  await syncWhoopRange(userId, start.toISOString());
}

/** Fetches and upserts a single resource by id — used by the webhook handler. */
export async function syncSingleResource(
  userId: string,
  type: "recovery" | "sleep" | "workout",
  id: string,
): Promise<void> {
  switch (type) {
    case "recovery": {
      // v2 recovery webhooks carry the sleep UUID, not a cycleId, and there's no
      // "get recovery by sleep id" endpoint — so pull a narrow recent window from the
      // list endpoint and upsert whichever record matches. Cheap: recovery only fires
      // a handful of times a day per user.
      const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      for await (const r of whoopPaginate<WhoopRecovery>(userId, "/v2/recovery", {
        start: since,
      })) {
        if (r.sleep_id === id) {
          await upsertRecovery(userId, r);
          return;
        }
      }
      logger.warn({ userId, id }, "recovery webhook referenced a sleep id not found in recent window");
      return;
    }
    case "sleep": {
      const s = await whoopGet<WhoopSleep>(userId, `/v2/activity/sleep/${id}`);
      await upsertSleep(userId, s);
      return;
    }
    case "workout": {
      const w = await whoopGet<WhoopWorkout>(userId, `/v2/activity/workout/${id}`);
      await upsertWorkout(userId, w);
      return;
    }
  }
}
