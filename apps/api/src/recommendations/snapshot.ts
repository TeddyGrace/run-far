import { and, eq, gte, lte, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, plannedRuns } from "../db/schema.js";
import { RECOMMENDATION_CONFIG } from "./config.js";
import type { RecoverySnapshot } from "@run-far/shared";

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

/**
 * Builds today's RecoverySnapshot for a user: recovery/HRV/RHR vs 30-day rolling baseline,
 * 7-day sleep debt, 7-day strain, and the 7d:28d planned-load ratio (ACWR). This is the only
 * place in the recommendation engine that touches the database — everything downstream
 * (the rules) is pure, taking this snapshot as input.
 */
export async function buildRecoverySnapshot(userId: string): Promise<RecoverySnapshot> {
  const today = new Date();
  const todayIso = isoDate(today);

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

  const [todayRow] = baselineRows.filter((r) => r.date === todayIso);

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

  const sleepWindowStart = isoDate(daysAgo(6));
  const sleepRows = await db
    .select()
    .from(sleepRecords)
    .where(
      and(
        eq(sleepRecords.userId, userId),
        gte(sleepRecords.date, sleepWindowStart),
        lte(sleepRecords.date, todayIso),
      ),
    );
  const sleepDebtMin7d = sleepRows.reduce((sum, r) => sum + (r.sleepDebtMin ?? 0), 0);

  const strainRows = await db
    .select()
    .from(whoopWorkouts)
    .where(
      and(
        eq(whoopWorkouts.userId, userId),
        gte(whoopWorkouts.date, sleepWindowStart),
        lte(whoopWorkouts.date, todayIso),
      ),
    );
  const strain7d = strainRows.length
    ? strainRows.reduce((sum, r) => sum + (r.strain ?? 0), 0)
    : null;

  const acuteWindowStart = daysAgo(6);
  const chronicWindowStart = daysAgo(27);
  const acuteRuns = await db
    .select()
    .from(plannedRuns)
    .where(
      and(
        eq(plannedRuns.userId, userId),
        gte(plannedRuns.scheduledAt, acuteWindowStart),
        lte(plannedRuns.scheduledAt, today),
      ),
    );
  const chronicRuns = await db
    .select()
    .from(plannedRuns)
    .where(
      and(
        eq(plannedRuns.userId, userId),
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

  return {
    date: todayIso,
    recoveryScore: todayRow?.recoveryScore ?? null,
    hrvRmssdMs: todayRow?.hrvRmssdMs ?? null,
    hrvBaselineMs,
    hrvBaselineSd,
    restingHr: todayRow?.restingHr ?? null,
    restingHrBaseline,
    sleepDebtMin7d: sleepRows.length ? sleepDebtMin7d : null,
    strain7d,
    acuteTss7d,
    chronicTss28d,
    acwr,
    hrvSuppressedConsecutiveDays,
  };
}
