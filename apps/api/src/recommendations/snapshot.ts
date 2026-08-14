import { and, eq, gte, lte, desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, plannedRuns } from "../db/schema.js";
import { RECOMMENDATION_CONFIG } from "./config.js";
import type { RecoverySnapshot } from "@run-far/shared";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";
import { dateYmdInZone } from "../lib/zonedTime.js";
import { getAthleteTimezone } from "../lib/athleteTimezone.js";
import { getCurrentCycle, getRecentCycles, getRecentCompletedCycles, cycleLoad } from "../metrics/cycleMetrics.js";

/** Whoop sport_name values that count as "runs" for mileage stats. */
const RUN_SPORTS = ["running", "trail_running", "treadmill_running"] as const;

/** How many completed cycles the rolling strain/load window looks back over. */
const STRAIN_WINDOW_CYCLES = 7;
/** How many recent cycles (open or closed) we walk when checking HRV-suppressed streak. */
const HRV_STREAK_LOOKBACK_CYCLES = 30;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Athlete-local calendar date of an instant. */
function localIsoDate(d: Date, tz: string): string {
  return dateYmdInZone(d, tz);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** Monday of the local calendar week containing `localIso` (a YYYY-MM-DD local date string).
 * Pure calendar arithmetic on the date string — no further timezone conversion needed since
 * the input is already the athlete's local date. */
function startOfLocalWeek(localIso: string): string {
  const [y, m, d] = localIso.split("-").map(Number) as [number, number, number];
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  const day = asUtc.getUTCDay(); // 0 = Sun
  asUtc.setUTCDate(asUtc.getUTCDate() - ((day + 6) % 7));
  return asUtc.toISOString().slice(0, 10);
}

function startOfLocalMonth(localIso: string): string {
  return `${localIso.slice(0, 7)}-01`;
}

/**
 * Builds today's RecoverySnapshot for a user: recovery/HRV/RHR vs 30-day rolling baseline,
 * today's sleep debt (Whoop's own figure is already a rolling/cumulative metric — never
 * re-aggregate it over multiple days), 7-cycle strain/load, and the 7d:28d planned-load ratio
 * (ACWR). This is the only place in the recommendation engine that touches the database —
 * everything downstream (the rules) is pure, taking this snapshot as input.
 *
 * "Today" for recovery/sleep debt/strain is resolved via Whoop's own Physiological Cycle, not
 * a naive calendar-date match: a cycle is wake-to-wake and can cross midnight, and a calendar
 * day can have both a nap and a main sleep, so date-string matching alone can pick the wrong
 * row. We look up the athlete's current (most recent) cycle and prefer rows tied to it,
 * falling back to the old date match only if no cycle data exists yet (new/unsynced user).
 * All calendar-date fields on the returned snapshot are the athlete's local date (their
 * configured timezone, or a cycle's own recorded offset), not UTC.
 */
export async function buildRecoverySnapshot(userId: string): Promise<RecoverySnapshot> {
  const tz = await getAthleteTimezone(userId);
  const today = new Date();
  const todayIso = localIsoDate(today, tz);

  const currentCycle = await getCurrentCycle(userId);

  const baselineWindowStart = localIsoDate(daysAgo(30), tz);
  const baselineRows = await db
    .select()
    .from(recoveryMetrics)
    .where(
      and(
        eq(recoveryMetrics.userId, userId),
        gte(recoveryMetrics.date, baselineWindowStart),
        lte(recoveryMetrics.date, todayIso),
      ),
    )
    .orderBy(desc(recoveryMetrics.date));

  const todayRow =
    (currentCycle && baselineRows.find((r) => r.cycleId === currentCycle.whoopCycleId)) ||
    baselineRows.find((r) => r.date === todayIso);

  const hrvValues = baselineRows.map((r) => r.hrvRmssdMs).filter((v): v is number => v != null);
  const rhrValues = baselineRows.map((r) => r.restingHr).filter((v): v is number => v != null);
  const hrvBaselineMs = mean(hrvValues);
  const hrvBaselineSd = hrvBaselineMs != null ? stddev(hrvValues, hrvBaselineMs) : null;
  const restingHrBaseline = mean(rhrValues);

  // Consecutive cycles (most recent first) where HRV sits >= threshold SDs below baseline.
  // Walking cycles rather than recovery rows means a cycle with no synced recovery yet reads
  // as a real gap (streak stops) instead of silently being skipped, which would have let a
  // missed sync day inflate the streak across it.
  let hrvSuppressedConsecutiveDays = 0;
  if (hrvBaselineMs != null && hrvBaselineSd != null && hrvBaselineSd > 0) {
    const recoveryByCycleId = new Map(
      baselineRows.filter((r) => r.cycleId != null).map((r) => [r.cycleId as string, r]),
    );
    const recentCyclesForStreak = await getRecentCycles(userId, HRV_STREAK_LOOKBACK_CYCLES);
    for (const cycle of recentCyclesForStreak) {
      const row = recoveryByCycleId.get(cycle.whoopCycleId);
      if (!row || row.hrvRmssdMs == null) break;
      const sdBelow = (hrvBaselineMs - row.hrvRmssdMs) / hrvBaselineSd;
      if (sdBelow >= RECOMMENDATION_CONFIG.hrv.suppressedSdThreshold) {
        hrvSuppressedConsecutiveDays++;
      } else {
        break;
      }
    }
  }

  let todaySleepRow: typeof sleepRecords.$inferSelect | undefined;
  if (currentCycle) {
    // The primary (non-nap) sleep tied to the current cycle — deterministic, unlike a same-date
    // match, which can't tell a nap from the main sleep when both land on the same calendar date.
    [todaySleepRow] = await db
      .select()
      .from(sleepRecords)
      .where(
        and(
          eq(sleepRecords.userId, userId),
          eq(sleepRecords.cycleId, currentCycle.whoopCycleId),
          eq(sleepRecords.nap, false),
        ),
      );
  }
  if (!todaySleepRow) {
    [todaySleepRow] = await db
      .select()
      .from(sleepRecords)
      .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.date, todayIso)));
  }
  const sleepDebtMinToday = todaySleepRow?.sleepDebtMin ?? null;

  // Strain/load are read from Whoop's own per-cycle score (cycles.strain / cycles.kilojoule),
  // not summed from individual workouts: strain is a logarithmic 0-21 score, so adding
  // workout strains together isn't a meaningful quantity, and it ignores non-workout strain
  // entirely. The open (still-accumulating) cycle is excluded from the rolling window and
  // reported separately as cycleStrainToday.
  const recentCompletedCycles = await getRecentCompletedCycles(userId, STRAIN_WINDOW_CYCLES);
  const cycleStrainValues = recentCompletedCycles
    .map((c) => c.strain)
    .filter((v): v is number => v != null);
  const cycleLoadValues = recentCompletedCycles
    .map((c) => cycleLoad(c))
    .filter((v): v is number => v != null);
  const cycleStrainAvg7d = cycleStrainValues.length ? mean(cycleStrainValues) : null;
  const cycleLoadSum7d = cycleLoadValues.length
    ? cycleLoadValues.reduce((a, b) => a + b, 0)
    : null;
  const cyclesCounted7d = cycleStrainValues.length;
  const cycleStrainToday = currentCycle?.strain ?? null;

  const acuteWindowStart = daysAgo(6);
  const chronicWindowStart = daysAgo(27);
  const activePlanId = await getActivePlanId(userId);
  const acuteRuns = await db
    .select()
    .from(plannedRuns)
    .where(
      and(
        visibleRunsSql(userId, activePlanId),
        gte(plannedRuns.scheduledAt, acuteWindowStart),
        lte(plannedRuns.scheduledAt, today),
      ),
    );
  const chronicRuns = await db
    .select()
    .from(plannedRuns)
    .where(
      and(
        visibleRunsSql(userId, activePlanId),
        gte(plannedRuns.scheduledAt, chronicWindowStart),
        lte(plannedRuns.scheduledAt, today),
      ),
    );

  const acuteTss7d = acuteRuns.length
    ? acuteRuns.reduce((sum, r) => sum + (r.plannedTss ?? 0), 0)
    : null;
  const chronicTss28d = chronicRuns.length
    ? chronicRuns.reduce((sum, r) => sum + (r.plannedTss ?? 0), 0)
    : null;
  const chronicWeeklyEquivalent = chronicTss28d != null ? chronicTss28d / 4 : null;
  const acwr =
    acuteTss7d != null && chronicWeeklyEquivalent != null && chronicWeeklyEquivalent > 0
      ? acuteTss7d / chronicWeeklyEquivalent
      : null;

  const weekStartIso = startOfLocalWeek(todayIso);
  const monthStartIso = startOfLocalMonth(todayIso);
  const runWorkouts = await db
    .select({ date: whoopWorkouts.date, distanceM: whoopWorkouts.distanceM })
    .from(whoopWorkouts)
    .where(
      and(
        eq(whoopWorkouts.userId, userId),
        inArray(whoopWorkouts.sport, [...RUN_SPORTS]),
        gte(whoopWorkouts.date, monthStartIso),
        lte(whoopWorkouts.date, todayIso),
      ),
    );

  let weekMeters = 0;
  let monthMeters = 0;
  let weekHasDistance = false;
  let monthHasDistance = false;
  for (const w of runWorkouts) {
    if (w.distanceM == null || w.distanceM <= 0) continue;
    monthMeters += w.distanceM;
    monthHasDistance = true;
    if (w.date >= weekStartIso) {
      weekMeters += w.distanceM;
      weekHasDistance = true;
    }
  }

  // Weekly average for the month so far: scale month total by days elapsed / 7.
  const dayOfMonth = Number(todayIso.slice(8, 10));
  const runDistanceMPerWeekThisMonth = monthHasDistance
    ? monthMeters / Math.max(dayOfMonth / 7, 1 / 7)
    : null;

  return {
    date: todayIso,
    timeZone: tz,
    recoveryScore: todayRow?.recoveryScore ?? null,
    hrvRmssdMs: todayRow?.hrvRmssdMs ?? null,
    hrvBaselineMs,
    hrvBaselineSd,
    restingHr: todayRow?.restingHr ?? null,
    restingHrBaseline,
    sleepDebtMinToday,
    cycleStrainAvg7d,
    cycleLoadSum7d,
    cycleStrainToday,
    cyclesCounted7d,
    acuteTss7d,
    chronicTss28d,
    acwr,
    runDistanceMThisWeek: weekHasDistance ? weekMeters : null,
    runDistanceMPerWeekThisMonth,
    hrvSuppressedConsecutiveDays,
    hasRecoveryToday: todayRow != null,
    hasSleepToday: todaySleepRow != null,
  };
}
