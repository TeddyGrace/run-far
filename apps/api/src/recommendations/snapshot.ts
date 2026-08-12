import { and, eq, gte, lte, desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, plannedRuns, cycles } from "../db/schema.js";
import { RECOMMENDATION_CONFIG } from "./config.js";
import type { RecoverySnapshot } from "@run-far/shared";
import { getActivePlanId, visibleRunsSql } from "../plans/lifecycle.js";

/** Whoop sport_name values that count as "runs" for mileage stats. */
const RUN_SPORTS = ["running", "trail_running", "treadmill_running"] as const;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function startOfUtcWeek(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Builds today's RecoverySnapshot for a user: recovery/HRV/RHR vs 30-day rolling baseline,
 * today's sleep debt (Whoop's own figure is already a rolling/cumulative metric — never
 * re-aggregate it over multiple days), 7-day strain, and the 7d:28d planned-load ratio
 * (ACWR). This is the only place in the recommendation engine that touches the database —
 * everything downstream (the rules) is pure, taking this snapshot as input.
 *
 * "Today" for recovery/sleep debt is resolved via Whoop's own Physiological Cycle, not a
 * naive UTC calendar-date match: a cycle is wake-to-wake and can cross midnight, and a
 * calendar day can have both a nap and a main sleep, so date-string matching alone can pick
 * the wrong row. We look up the athlete's current (most recent) cycle and prefer rows tied to
 * it, falling back to the old date match only if no cycle data exists yet (new/unsynced user).
 */
export async function buildRecoverySnapshot(userId: string): Promise<RecoverySnapshot> {
  const today = new Date();
  const todayIso = isoDate(today);

  const [currentCycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.userId, userId))
    .orderBy(desc(cycles.start))
    .limit(1);

  const baselineWindowStart = isoDate(daysAgo(30));
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

  // Consecutive days (most recent first) where HRV sits >= threshold SDs below baseline.
  let hrvSuppressedConsecutiveDays = 0;
  if (hrvBaselineMs != null && hrvBaselineSd != null && hrvBaselineSd > 0) {
    for (const row of baselineRows) {
      if (row.hrvRmssdMs == null) break;
      const sdBelow = (hrvBaselineMs - row.hrvRmssdMs) / hrvBaselineSd;
      if (sdBelow >= RECOMMENDATION_CONFIG.hrv.suppressedSdThreshold) {
        hrvSuppressedConsecutiveDays++;
      } else {
        break;
      }
    }
  }

  const strainWindowStart = isoDate(daysAgo(6));

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

  const strainRows = await db
    .select()
    .from(whoopWorkouts)
    .where(
      and(
        eq(whoopWorkouts.userId, userId),
        gte(whoopWorkouts.date, strainWindowStart),
        lte(whoopWorkouts.date, todayIso),
      ),
    );
  const strain7d = strainRows.length
    ? strainRows.reduce((sum, r) => sum + (r.strain ?? 0), 0)
    : null;

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

  const weekStartIso = isoDate(startOfUtcWeek(today));
  const monthStartIso = isoDate(startOfUtcMonth(today));
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
  const dayOfMonth = today.getUTCDate();
  const runDistanceMPerWeekThisMonth = monthHasDistance
    ? monthMeters / Math.max(dayOfMonth / 7, 1 / 7)
    : null;

  return {
    date: todayIso,
    recoveryScore: todayRow?.recoveryScore ?? null,
    hrvRmssdMs: todayRow?.hrvRmssdMs ?? null,
    hrvBaselineMs,
    hrvBaselineSd,
    restingHr: todayRow?.restingHr ?? null,
    restingHrBaseline,
    sleepDebtMinToday,
    strain7d,
    acuteTss7d,
    chronicTss28d,
    acwr,
    runDistanceMThisWeek: weekHasDistance ? weekMeters : null,
    runDistanceMPerWeekThisMonth,
    hrvSuppressedConsecutiveDays,
  };
}
