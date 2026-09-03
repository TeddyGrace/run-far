import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, cycles, syncState } from "../../db/schema.js";
import { whoopGet, whoopPaginate } from "./client.js";
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from "./types.js";
import { logger } from "../../lib/logger.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";
import { getAthleteTimezone } from "../../lib/athleteTimezone.js";
import { cycleLocalDate } from "../../metrics/cycleMetrics.js";

/** Athlete-local calendar date for a raw Whoop ISO timestamp. Whoop's sleep/workout payloads
 * don't carry a per-event timezone offset, so the athlete's configured timezone is the best
 * available signal — unlike cycles, which do carry their own offset (see cycleLocalDate).
 * Exported for testing: this is what fixes the bug where an evening workout landed on the
 * following UTC calendar day. */
export function toLocalDateOnly(iso: string, tz: string): string {
  return dateYmdInZone(new Date(iso), tz);
}

async function upsertCycle(userId: string, c: WhoopCycle): Promise<void> {
  const row = {
    start: new Date(c.start),
    end: c.end ? new Date(c.end) : null,
    timezoneOffset: c.timezone_offset,
    scoreState: c.score_state,
    strain: c.score?.strain ?? null,
    kilojoule: c.score?.kilojoule ?? null,
    avgHr: c.score?.average_heart_rate ?? null,
    maxHr: c.score?.max_heart_rate ?? null,
  };

  await db
    .insert(cycles)
    .values({
      userId,
      whoopCycleId: String(c.id),
      ...row,
    })
    .onConflictDoUpdate({
      target: [cycles.userId, cycles.whoopCycleId],
      set: { ...row, updatedAt: new Date() },
    });
}

/** The date a recovery describes is the cycle it belongs to (wake-to-wake), not the instant
 * Whoop finished scoring it (r.created_at, which can land after local midnight). Cycles sync
 * before recovery in a full range sync, but a webhook-triggered single upsert can race ahead
 * of its cycle — fall back to created_at (best-effort) only when the cycle isn't there yet. */
async function recoveryLocalDate(userId: string, r: WhoopRecovery, tz: string): Promise<string> {
  const [cycle] = await db
    .select({ start: cycles.start, timezoneOffset: cycles.timezoneOffset })
    .from(cycles)
    .where(and(eq(cycles.userId, userId), eq(cycles.whoopCycleId, String(r.cycle_id))));
  if (cycle) return cycleLocalDate(cycle, tz);
  return toLocalDateOnly(r.created_at, tz);
}

async function upsertRecovery(userId: string, r: WhoopRecovery, tz: string): Promise<void> {
  const date = await recoveryLocalDate(userId, r, tz);
  await db
    .insert(recoveryMetrics)
    .values({
      userId,
      whoopSleepId: r.sleep_id,
      cycleId: String(r.cycle_id),
      date,
      recoveryScore: r.score?.recovery_score ?? null,
      hrvRmssdMs: r.score?.hrv_rmssd_milli ?? null,
      restingHr: r.score?.resting_heart_rate ?? null,
      spo2: r.score?.spo2_percentage ?? null,
      skinTempC: r.score?.skin_temp_celsius ?? null,
      scoreState: r.score_state,
    })
    .onConflictDoUpdate({
      target: [recoveryMetrics.userId, recoveryMetrics.whoopSleepId],
      set: {
        cycleId: String(r.cycle_id),
        date,
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

async function upsertSleep(userId: string, s: WhoopSleep, tz: string): Promise<void> {
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
      cycleId: String(s.cycle_id),
      nap: s.nap ?? false,
      date: toLocalDateOnly(s.start, tz),
      durationMin,
      efficiencyPct: s.score?.stage_summary.sleep_efficiency_percentage ?? null,
      performancePct,
      sleepDebtMin,
      respiratoryRate: s.score?.respiratory_rate ?? null,
    })
    .onConflictDoUpdate({
      target: [sleepRecords.userId, sleepRecords.whoopSleepId],
      set: {
        cycleId: String(s.cycle_id),
        nap: s.nap ?? false,
        durationMin,
        efficiencyPct: s.score?.stage_summary.sleep_efficiency_percentage ?? null,
        performancePct,
        sleepDebtMin,
        respiratoryRate: s.score?.respiratory_rate ?? null,
        updatedAt: new Date(),
      },
    });
}

async function upsertWorkout(userId: string, w: WhoopWorkout, tz: string): Promise<void> {
  const startedAt = new Date(w.start);
  const endedAt = new Date(w.end);
  const durationMin =
    Number.isFinite(startedAt.getTime()) && Number.isFinite(endedAt.getTime())
      ? Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 60_000)
      : null;
  const score = w.score;
  const distanceM = score?.distance_meter ?? null;
  const row = {
    startedAt: Number.isFinite(startedAt.getTime()) ? startedAt : null,
    durationMin,
    sport: w.sport_name ?? null,
    strain: score?.strain ?? null,
    avgHr: score?.average_heart_rate ?? null,
    maxHr: score?.max_heart_rate ?? null,
    kilojoules: score?.kilojoule ?? null,
    distanceM,
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
      date: toLocalDateOnly(w.start, tz),
      ...row,
    })
    .onConflictDoUpdate({
      target: [whoopWorkouts.userId, whoopWorkouts.whoopWorkoutId],
      set: {
        ...row,
        // Whoop can report a workout before scoring finishes (or never populate distance for a
        // no-GPS activity) and re-sync it later with distance still null — never let that null
        // clobber a real value, whether it came from Whoop earlier or the athlete hand-entered
        // it. A fresh non-null distance from Whoop still wins over a manual entry.
        distanceM: distanceM != null ? distanceM : sql`${whoopWorkouts.distanceM}`,
        distanceManual: distanceM != null ? false : sql`${whoopWorkouts.distanceManual}`,
        updatedAt: new Date(),
      },
    });
}

/** Full sync of cycle/recovery/sleep/workout for a date range. Used for backfill and as a nightly safety net. */
export async function syncWhoopRange(userId: string, start: string, end?: string): Promise<void> {
  const tz = await getAthleteTimezone(userId);

  // Cycles first: recovery/sleep rows reference cycleId, and there are no cycle.* webhooks,
  // so a full range sync is the only way cycles ever get backfilled/refreshed in bulk.
  let cycleCount = 0;
  for await (const c of whoopPaginate<WhoopCycle>(userId, "/v2/cycle", { start, end })) {
    await upsertCycle(userId, c);
    cycleCount++;
  }

  let recoveryCount = 0;
  for await (const r of whoopPaginate<WhoopRecovery>(userId, "/v2/recovery", { start, end })) {
    await upsertRecovery(userId, r, tz);
    recoveryCount++;
  }

  let sleepCount = 0;
  for await (const s of whoopPaginate<WhoopSleep>(userId, "/v2/activity/sleep", { start, end })) {
    await upsertSleep(userId, s, tz);
    sleepCount++;
  }

  let workoutCount = 0;
  for await (const w of whoopPaginate<WhoopWorkout>(userId, "/v2/activity/workout", {
    start,
    end,
  })) {
    await upsertWorkout(userId, w, tz);
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
    { userId, cycleCount, recoveryCount, sleepCount, workoutCount, start, end },
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

/** Whoop has no cycle.* webhooks, so a cycle only gets refreshed by piggybacking on the
 * sleep/recovery webhook handlers (both of which reference a cycle_id) — this fetches and
 * upserts just that one cycle. Best-effort: a failure here shouldn't fail the sleep/recovery
 * sync that triggered it, since a later full sync (nightly safety net) will catch it up. */
async function syncCycleById(userId: string, whoopCycleId: number): Promise<void> {
  try {
    const c = await whoopGet<WhoopCycle>(userId, `/v2/cycle/${whoopCycleId}`);
    await upsertCycle(userId, c);
  } catch (err) {
    logger.warn({ err, userId, whoopCycleId }, "failed to refresh cycle after webhook");
  }
}

/** Fetches and upserts a single resource by id — used by the webhook handler. */
export async function syncSingleResource(
  userId: string,
  type: "recovery" | "sleep" | "workout",
  id: string,
): Promise<void> {
  const tz = await getAthleteTimezone(userId);
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
          // Sync the cycle first: recoveryLocalDate() needs it in the DB to derive the
          // correct wake-to-wake date instead of falling back to created_at.
          await syncCycleById(userId, r.cycle_id);
          await upsertRecovery(userId, r, tz);
          return;
        }
      }
      logger.warn({ userId, id }, "recovery webhook referenced a sleep id not found in recent window");
      return;
    }
    case "sleep": {
      const s = await whoopGet<WhoopSleep>(userId, `/v2/activity/sleep/${id}`);
      await upsertSleep(userId, s, tz);
      // The primary sleep starts a new cycle; a nap attaches to the current one — either way,
      // refresh that cycle now rather than waiting for the next full sync.
      await syncCycleById(userId, s.cycle_id);
      return;
    }
    case "workout": {
      const w = await whoopGet<WhoopWorkout>(userId, `/v2/activity/workout/${id}`);
      await upsertWorkout(userId, w, tz);
      return;
    }
  }
}
