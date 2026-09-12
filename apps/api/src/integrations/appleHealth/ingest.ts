import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { cycles, recoveryMetrics, sleepRecords, syncState, workouts } from "../../db/schema.js";
import { getAthleteTimezone } from "../../lib/athleteTimezone.js";
import { logger } from "../../lib/logger.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";
import { reconcileUserSafe } from "../../reconciliation/service.js";
import { generateRecommendationsSafe } from "../../recommendations/service.js";
import { classifySleeps, synthesizeCycles, type SleepForCycles } from "./cycles.js";
import {
  deriveRecoveryScore,
  deriveSleepNeedMin,
  MIN_BASELINE_DAYS,
  sampleStats,
  type RecoveryBaselines,
} from "./recoveryScore.js";
import { computeRollingSleepDebt, type NightForDebt } from "./sleepDebt.js";
import { resolveSport } from "./sports.js";
import type { AppleHealthIngestInput, AppleHealthIngestResult } from "@run-far/shared";

/**
 * How far back a batch's derived values are recomputed.
 *
 * Everything derived here — the recovery score, sleep debt, a cycle's energy total — is a
 * function of the athlete's surrounding history, not of the batch alone. A night ingested today
 * shifts the baseline that yesterday's score was computed against, and a workout arriving late
 * belongs to a cycle whose energy total was already written. So ingest does not incrementally
 * patch: it re-derives the window from current data, the same way the reconciliation sweep
 * re-decides rather than trusting its earlier guesses. Late data, corrected data and deleted
 * data then all converge instead of leaving a stale figure behind.
 *
 * 45 days is well past the 30-day baseline window the snapshot uses, so a backfill lands with
 * its scores already consistent with the history it brought with it.
 */
const REDERIVE_WINDOW_DAYS = 45;

/** Trailing window the recovery baselines are computed over, matching the 30 days
 * buildRecoverySnapshot uses for its own HRV/RHR baselines so the two never disagree about
 * what "baseline" means. */
const BASELINE_WINDOW_DAYS = 30;

/**
 * Ingest a batch of Apple Health data pushed by the iOS app.
 *
 * Idempotent by construction: every row is upserted on (user, provider, external_id) using the
 * provider's own stable UUIDs, so replaying a batch — which the app will do, since it retries
 * and since its HealthKit anchors overlap — changes nothing.
 */
export async function ingestAppleHealth(
  userId: string,
  payload: AppleHealthIngestInput,
  opts: { now?: Date } = {},
): Promise<AppleHealthIngestResult> {
  const now = opts.now ?? new Date();
  // Dates are bucketed in the athlete's configured timezone, not the device's. The device's
  // zone is recorded for diagnostics but deliberately not authoritative: a run logged on a trip
  // must land on the same calendar day here as it does on the dashboard, the calendar and the
  // plan, all of which use the configured zone.
  const timeZone = await getAthleteTimezone(userId);

  // Ordered by dependency, not convenience. Sleep sessions must exist before cycles, because a
  // cycle boundary *is* a waking. The night's raw readings must be stored before scoring, since
  // scoring reads them back from the database (which is what lets it re-score nights outside
  // this batch). And cycles must exist before recovery, so each recovery row can be filed
  // against the cycle its night opens.
  const workoutCount = await upsertWorkouts(userId, payload, timeZone);
  const sleepCount = await upsertSleepSessions(userId, payload, timeZone);
  await upsertRawReadings(userId, payload, timeZone);
  const cycleCount = await rebuildCycles(userId, timeZone, now);
  const recovery = await rederiveRecovery(userId, timeZone, now);

  // The watermark the reconciliation sweep's coverage gate reads. Clamped to `now` so a device
  // with a skewed clock cannot claim we have seen the future: the gate's whole purpose is to
  // refuse to call a session missed unless we would have seen it, and a watermark ahead of real
  // time would assert coverage over days no data could have reached us for yet.
  const coveredThrough = new Date(
    Math.min(new Date(payload.coveredThrough).getTime(), now.getTime()),
  );
  await db
    .insert(syncState)
    .values({ userId, provider: "apple_health", lastPolledAt: coveredThrough })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { lastPolledAt: coveredThrough, updatedAt: new Date() },
    });

  logger.info(
    {
      userId,
      workouts: workoutCount,
      sleepSessions: sleepCount,
      cycles: cycleCount,
      recoveryRows: recovery.rows,
      recoveryScored: recovery.scored,
      baselineDays: recovery.baselineDays,
      device: payload.device,
    },
    "apple health ingest complete",
  );

  // Same post-ingest steps the Whoop path takes, and for the same reasons: a workout landing is
  // what can turn a planned run into a completed one, and a morning's recovery is the cue to
  // refresh today's advice. Both are best-effort — the app must get its 200 and clear its queue
  // even if a downstream sweep fails, or it will resend the same batch forever.
  await reconcileUserSafe(userId);
  await generateRecommendationsSafe(userId, { notify: true, ingestion: true });

  return {
    workouts: workoutCount,
    sleepSessions: sleepCount,
    cycles: cycleCount,
    recoveryRows: recovery.rows,
    recoveryScored: recovery.scored,
    baselineDays: recovery.baselineDays,
    baselineDaysRequired: MIN_BASELINE_DAYS,
    coveredThrough: coveredThrough.toISOString(),
  };
}

async function upsertWorkouts(
  userId: string,
  payload: AppleHealthIngestInput,
  timeZone: string,
): Promise<number> {
  for (const w of payload.workouts) {
    const startedAt = new Date(w.startedAt);
    const endedAt = new Date(w.endedAt);
    if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime())) continue;

    // HKWorkout.duration excludes paused time, so it is the honest figure when the device sent
    // it; the wall-clock span is the fallback.
    const durationMin =
      w.durationMin ?? Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 60_000);

    const row = {
      startedAt,
      durationMin,
      sport: resolveSport(w.activityType, w.indoor),
      // Apple publishes no strain equivalent, and inventing one on a log scale whose shape we
      // don't know would be a fabrication. Load rides on kilojoules instead — see cycleLoad.
      strain: null,
      avgHr: w.avgHr,
      maxHr: w.maxHr,
      kilojoules: w.activeEnergyKj,
      distanceM: w.distanceM,
      altitudeGainM: w.elevationAscendedM,
      // Whoop-only fields: HealthKit exposes neither a recording-coverage percentage nor
      // Whoop's HR-zone taxonomy.
      percentRecorded: null,
      altitudeChangeM: null,
      zoneDurations: null,
    };

    await db
      .insert(workouts)
      .values({
        userId,
        provider: "apple_health",
        externalId: w.externalId,
        date: dateYmdInZone(startedAt, timeZone),
        ...row,
      })
      .onConflictDoUpdate({
        target: [workouts.userId, workouts.provider, workouts.externalId],
        set: {
          ...row,
          date: dateYmdInZone(startedAt, timeZone),
          // Same rule as the Whoop path: a resync must never let a null distance clobber a real
          // one, whether it came from the provider earlier or the athlete hand-entered it. The
          // case this protects is common on Apple — an indoor treadmill run has no GPS
          // distance, so the athlete enters it and every later sync re-sends null.
          distanceM: w.distanceM != null ? w.distanceM : sql`${workouts.distanceM}`,
          distanceManual: w.distanceM != null ? false : sql`${workouts.distanceManual}`,
          updatedAt: new Date(),
        },
      });
  }
  return payload.workouts.length;
}

async function upsertSleepSessions(
  userId: string,
  payload: AppleHealthIngestInput,
  timeZone: string,
): Promise<number> {
  const sessions = payload.sleepSessions
    .map((s) => ({ ...s, startedAt: new Date(s.startedAt), endedAt: new Date(s.endedAt) }))
    .filter(
      (s) => Number.isFinite(s.startedAt.getTime()) && Number.isFinite(s.endedAt.getTime()),
    );

  // Nap vs primary sleep is re-derived here rather than trusted from the device, because the
  // snapshot resolves "last night's sleep" as the primary sleep of the current cycle — a nap
  // promoted to primary would report a 25-minute night and a wildly wrong sleep debt.
  const classified = classifySleeps(
    sessions.map<SleepForCycles>((s) => ({
      externalId: s.externalId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      asleepMin: s.asleepMin,
    })),
    timeZone,
  );
  const napByExternalId = new Map(classified.map((c) => [c.externalId, c.nap]));

  for (const s of sessions) {
    const inBed = s.inBedMin;
    const asleep = s.asleepMin;
    // Efficiency needs both figures, and many watch-only sleepers have no inBed samples at all
    // — null then, rather than a 100% that would read as a perfect night.
    const efficiencyPct =
      inBed != null && inBed > 0 && asleep != null ? Math.min(100, (asleep / inBed) * 100) : null;

    const row = {
      cycleId: null as string | null, // linked by rebuildCycles once cycles exist
      nap: napByExternalId.get(s.externalId) ?? false,
      durationMin: asleep,
      efficiencyPct,
      // Whoop's "sleep performance" is its own score against its own need model. Nothing in
      // HealthKit corresponds to it, and the closest stand-in (duration / derived need) would
      // be a different quantity wearing its name — so it stays null, and the frontend shows
      // nothing rather than something misattributed.
      performancePct: null,
      respiratoryRate: s.respiratoryRate,
      inBedMin: inBed,
      lightMin: s.lightMin,
      deepMin: s.deepMin,
      remMin: s.remMin,
      awakeMin: s.awakeMin,
    };

    await db
      .insert(sleepRecords)
      .values({
        userId,
        provider: "apple_health",
        externalId: s.externalId,
        // Filed under the local date of waking: the night of the 5th that ends on the morning
        // of the 6th is the 6th's sleep, since it is what the 6th's recovery is scored from.
        date: dateYmdInZone(s.endedAt, timeZone),
        ...row,
      })
      .onConflictDoUpdate({
        target: [sleepRecords.userId, sleepRecords.provider, sleepRecords.externalId],
        set: { ...row, date: dateYmdInZone(s.endedAt, timeZone), updatedAt: new Date() },
      });
  }

  return sessions.length;
}

/**
 * Re-derive cycles across the window from the sleep and workout rows now in the database.
 *
 * Rebuilt from stored rows rather than from the batch: a cycle spans from one waking to the
 * next, so the batch that delivers tonight's sleep is what *closes* yesterday's cycle, and a
 * cycle's energy total can be changed by a workout that arrives days later. Deriving from the
 * database is what makes both of those land.
 */
async function rebuildCycles(userId: string, timeZone: string, now: Date): Promise<number> {
  const fromYmd = dateYmdInZone(new Date(now.getTime() - REDERIVE_WINDOW_DAYS * 86_400_000), timeZone);

  const sleepRows = await db
    .select()
    .from(sleepRecords)
    .where(
      and(
        eq(sleepRecords.userId, userId),
        eq(sleepRecords.provider, "apple_health"),
        gte(sleepRecords.date, fromYmd),
      ),
    )
    .orderBy(asc(sleepRecords.date));

  const workoutRows = await db
    .select({ startedAt: workouts.startedAt, kilojoules: workouts.kilojoules })
    .from(workouts)
    .where(
      and(
        eq(workouts.userId, userId),
        eq(workouts.provider, "apple_health"),
        gte(workouts.date, fromYmd),
      ),
    );

  // The primary-sleep set is taken from the stored `nap` flag, which upsertSleepSessions just
  // re-derived — so cycles and the nap classification can't disagree.
  //
  // `sleep_records` stores a local date rather than the sleep's instants, so the cycle boundary
  // is reconstructed from that date: a cycle opens at the waking that ended that night's sleep.
  // Local noon stands in for the waking instant. Noon, not midnight, because the cycle's
  // synthetic id is derived from this instant's local date — a midnight anchor lands on the
  // previous day under any positive UTC offset and would mint a second cycle for the same
  // night. The instant itself is never shown to the athlete; only its date and the ordering
  // between cycles are read.
  const boundaries = sleepRows
    .filter((r) => !r.nap)
    .map((r) => {
      const wakeInstant = localNoon(r.date, timeZone);
      return {
        externalId: r.externalId,
        startedAt: wakeInstant,
        endedAt: wakeInstant,
        asleepMin: r.durationMin,
        wakeLocalDate: r.date,
      };
    });

  const synthesized = synthesizeCycles(
    boundaries,
    workoutRows
      .filter((w) => w.startedAt != null)
      .map((w) => ({ startedAt: w.startedAt as Date, activeEnergyKj: w.kilojoules })),
    timeZone,
  );

  for (const c of synthesized) {
    const row = {
      start: c.start,
      end: c.end,
      // No per-cycle offset to record: unlike Whoop, which reports the offset the cycle was
      // lived in, these are derived in the athlete's configured zone. cycleLocalDate falls back
      // to that zone when the offset is null, which is exactly right here.
      timezoneOffset: null,
      strain: null,
      kilojoule: c.kilojoule,
      // Nothing to score: the cycle is a derived container, and its recovery lives on the
      // recovery_metrics row that references it.
      scoreState: "SCORED" as const,
      avgHr: null,
      maxHr: null,
    };
    await db
      .insert(cycles)
      .values({ userId, provider: "apple_health", externalId: c.externalId, ...row })
      .onConflictDoUpdate({
        target: [cycles.userId, cycles.provider, cycles.externalId],
        set: { ...row, updatedAt: new Date() },
      });

    // Link the night's sleep to the cycle its waking opens, so the snapshot's cycle-anchored
    // lookup (rather than its date fallback) is what resolves last night's sleep.
    await db
      .update(sleepRecords)
      .set({ cycleId: c.externalId })
      .where(
        and(
          eq(sleepRecords.userId, userId),
          eq(sleepRecords.provider, "apple_health"),
          eq(sleepRecords.externalId, c.sleepExternalId),
        ),
      );
  }

  return synthesized.length;
}

/**
 * Re-derive every recovery row in the window: raw readings from the sleep sessions, baselines
 * from the athlete's own trailing history, and a score only once there is enough of it.
 *
 * Recomputed rather than patched because a score is a statement about a night *relative to the
 * nights around it*. Tonight's reading moves the baseline that last week's scores were computed
 * against, so leaving those in place would mean the dashboard shows scores measured against a
 * baseline that no longer exists.
 */
async function rederiveRecovery(
  userId: string,
  timeZone: string,
  now: Date,
): Promise<{ rows: number; scored: number; baselineDays: number }> {
  const todayYmd = dateYmdInZone(now, timeZone);
  const fromYmd = dateYmdInZone(new Date(now.getTime() - REDERIVE_WINDOW_DAYS * 86_400_000), timeZone);

  // Primary sleeps only: naps carry no morning readings and are not what a day's recovery
  // describes.
  const nights = await db
    .select()
    .from(sleepRecords)
    .where(
      and(
        eq(sleepRecords.userId, userId),
        eq(sleepRecords.provider, "apple_health"),
        eq(sleepRecords.nap, false),
        gte(sleepRecords.date, fromYmd),
        lte(sleepRecords.date, todayYmd),
      ),
    )
    .orderBy(asc(sleepRecords.date));

  if (nights.length === 0) return { rows: 0, scored: 0, baselineDays: 0 };

  // Existing recovery rows hold the raw readings the iOS app sent; the sleep rows hold the
  // durations. Both are needed to re-score, and the readings are read back from storage rather
  // than from the batch so nights outside this batch are re-scored too.
  const existing = await db
    .select()
    .from(recoveryMetrics)
    .where(
      and(
        eq(recoveryMetrics.userId, userId),
        eq(recoveryMetrics.provider, "apple_health"),
        gte(recoveryMetrics.date, fromYmd),
        lte(recoveryMetrics.date, todayYmd),
      ),
    );
  const readingsBySleepId = new Map(existing.map((r) => [r.externalId, r]));

  // Sleep need and debt over the same series, oldest first — the debt figure is cumulative, so
  // it can only be computed over the whole run of nights (see sleepDebt.ts).
  const trailingAsleep = nights
    .map((n) => n.durationMin)
    .filter((v): v is number => v != null && v > 0);
  const sleepNeedMin = deriveSleepNeedMin(trailingAsleep);
  const debtByDate = computeRollingSleepDebt(
    nights.map<NightForDebt>((n) => ({
      localDate: n.date,
      asleepMin: n.durationMin,
      sleepNeedMin,
    })),
  );

  let scored = 0;
  for (const night of nights) {
    const reading = readingsBySleepId.get(night.externalId);
    // A night with no recovery row yet and no readings to build one from contributes to the
    // baseline series and nothing else.
    const baselines = await buildBaselines(userId, night.date);

    const derived = deriveRecoveryScore(
      {
        hrvMs: reading?.hrvRmssdMs ?? null,
        restingHr: reading?.restingHr ?? null,
        asleepMin: night.durationMin,
        sleepNeedMin,
        respiratoryRate: night.respiratoryRate,
        skinTempC: reading?.skinTempC ?? null,
      },
      baselines,
    );
    if (derived.score != null) scored++;

    await db
      .update(sleepRecords)
      .set({ sleepNeedMin, sleepDebtMin: debtByDate.get(night.date) ?? null, updatedAt: new Date() })
      .where(
        and(
          eq(sleepRecords.userId, userId),
          eq(sleepRecords.provider, "apple_health"),
          eq(sleepRecords.externalId, night.externalId),
        ),
      );

    const row = {
      cycleId: night.cycleId,
      date: night.date,
      recoveryScore: derived.score,
      recoveryScoreSource: "derived" as const,
      scoreComponents: derived.components,
      hrvRmssdMs: reading?.hrvRmssdMs ?? null,
      hrvMetric: "sdnn" as const,
      restingHr: reading?.restingHr ?? null,
      spo2: reading?.spo2 ?? null,
      skinTempC: reading?.skinTempC ?? null,
      scoreState: derived.scoreState,
    };
    await db
      .insert(recoveryMetrics)
      .values({ userId, provider: "apple_health", externalId: night.externalId, ...row })
      .onConflictDoUpdate({
        target: [recoveryMetrics.userId, recoveryMetrics.provider, recoveryMetrics.externalId],
        set: { ...row, updatedAt: new Date() },
      });
  }

  const finalBaselines = await buildBaselines(userId, todayYmd);
  return { rows: nights.length, scored, baselineDays: finalBaselines.days };
}

/**
 * Baselines for one night, built from the days *before* it.
 *
 * Strictly before, not including: a z-score of a reading against a baseline that contains that
 * same reading is pulled toward zero by its own value, which flattens exactly the outlier days
 * the engine exists to notice. The effect is largest on a thin history, which is when it would
 * do the most damage.
 */
async function buildBaselines(userId: string, beforeYmd: string): Promise<RecoveryBaselines> {
  const windowStart = shiftYmd(beforeYmd, -BASELINE_WINDOW_DAYS);

  const rows = await db
    .select({
      date: recoveryMetrics.date,
      hrvRmssdMs: recoveryMetrics.hrvRmssdMs,
      restingHr: recoveryMetrics.restingHr,
      skinTempC: recoveryMetrics.skinTempC,
    })
    .from(recoveryMetrics)
    .where(
      and(
        eq(recoveryMetrics.userId, userId),
        eq(recoveryMetrics.provider, "apple_health"),
        gte(recoveryMetrics.date, windowStart),
        sql`${recoveryMetrics.date} < ${beforeYmd}`,
      ),
    )
    .orderBy(desc(recoveryMetrics.date));

  const respiratoryRows = await db
    .select({ date: sleepRecords.date, respiratoryRate: sleepRecords.respiratoryRate })
    .from(sleepRecords)
    .where(
      and(
        eq(sleepRecords.userId, userId),
        eq(sleepRecords.provider, "apple_health"),
        eq(sleepRecords.nap, false),
        gte(sleepRecords.date, windowStart),
        sql`${sleepRecords.date} < ${beforeYmd}`,
      ),
    );

  const nonNull = (vs: Array<number | null>) => vs.filter((v): v is number => v != null);

  return {
    hrv: sampleStats(nonNull(rows.map((r) => r.hrvRmssdMs))),
    restingHr: sampleStats(nonNull(rows.map((r) => r.restingHr))),
    skinTempC: sampleStats(nonNull(rows.map((r) => r.skinTempC))),
    respiratoryRate: sampleStats(nonNull(respiratoryRows.map((r) => r.respiratoryRate))),
    // Distinct dates, not row count: two sessions on one date are one day of history.
    days: new Set(rows.map((r) => r.date)).size,
  };
}

/**
 * Store the readings the app sent for each night, before any scoring happens.
 *
 * Split from scoring because the two have different lifetimes: the readings are facts from the
 * device and are written once, while the score is re-derived from them on every later ingest as
 * the baseline moves.
 */
async function upsertRawReadings(
  userId: string,
  payload: AppleHealthIngestInput,
  timeZone: string,
): Promise<number> {
  let written = 0;
  for (const s of payload.sleepSessions) {
    const endedAt = new Date(s.endedAt);
    if (!Number.isFinite(endedAt.getTime())) continue;
    // No score and no source opinion yet — rederiveRecovery owns both, and writes them in the
    // same ingest a moment later. PENDING_SCORE is the honest interim state.
    const row = {
      date: dateYmdInZone(endedAt, timeZone),
      hrvRmssdMs: s.hrvSdnnMs,
      hrvMetric: "sdnn" as const,
      restingHr: s.restingHr,
      spo2: s.oxygenSaturationPct,
      skinTempC: s.wristTempC,
      recoveryScoreSource: "derived" as const,
    };
    await db
      .insert(recoveryMetrics)
      .values({
        userId,
        provider: "apple_health",
        externalId: s.externalId,
        scoreState: "PENDING_SCORE",
        ...row,
      })
      .onConflictDoUpdate({
        target: [recoveryMetrics.userId, recoveryMetrics.provider, recoveryMetrics.externalId],
        set: { ...row, updatedAt: new Date() },
      });
    written++;
  }
  return written;
}

/** Local noon of a YYYY-MM-DD date, as an instant. Noon rather than midnight so the instant
 * stays on the intended local date under any UTC offset and across a DST transition — a
 * midnight-anchored instant lands on the previous day for any positive offset. */
function localNoon(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  // Start from the naive UTC noon and correct by the zone's offset at that instant.
  const naive = Date.UTC(y, m - 1, d, 12, 0, 0);
  const offsetMs = zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offsetMs);
}

/** The zone's UTC offset, in ms, at a given instant. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // Intl renders midnight as hour 24 in some environments with hour12: false.
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime();
}

/** Shift a YYYY-MM-DD date by whole days, staying in date space. */
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
