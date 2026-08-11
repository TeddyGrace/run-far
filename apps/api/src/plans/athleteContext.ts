import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { trainingPlans, whoopWorkouts } from "../db/schema.js";
import { buildRecoverySnapshot } from "../recommendations/snapshot.js";
import { logger } from "../lib/logger.js";

const RUN_SPORTS = ["running", "trail_running", "treadmill_running"] as const;
const DAY_MS = 86_400_000;
const METERS_PER_MILE = 1609.344;

export interface AthleteContext {
  todayIso: string;
  trailingWeeks: number;
  weeklyMileage: Array<{ weekStart: string; miles: number; runs: number }>;
  avgWeeklyMiles: number | null;
  maxWeeklyMiles: number | null;
  longestRunMiles: number | null;
  typicalRunDaysPerWeek: number | null;
  recovery: {
    recoveryScore: number | null;
    hrvRmssdMs: number | null;
    restingHr: number | null;
    acwr: number | null;
  };
  activePlan: { name: string; runCount: number } | null;
  dataQuality: "none" | "sparse" | "ok";
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mondayKey(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const day = date.getUTCDay();
  const monday = new Date(date.getTime() - ((day + 6) % 7) * DAY_MS);
  return isoDate(monday);
}

/**
 * Snapshot of the athlete's recent training so the coach doesn't design in a vacuum.
 * Pulls trailing Whoop run mileage, a recovery summary, and any active plan.
 */
export async function getAthleteContext(userId: string, trailingWeeks = 8): Promise<AthleteContext> {
  const today = new Date();
  const todayIso = isoDate(today);
  const windowStart = new Date(today.getTime() - trailingWeeks * 7 * DAY_MS);
  const windowStartIso = isoDate(windowStart);

  const runs = await db
    .select({
      date: whoopWorkouts.date,
      distanceM: whoopWorkouts.distanceM,
    })
    .from(whoopWorkouts)
    .where(
      and(
        eq(whoopWorkouts.userId, userId),
        inArray(whoopWorkouts.sport, [...RUN_SPORTS]),
        gte(whoopWorkouts.date, windowStartIso),
        lte(whoopWorkouts.date, todayIso),
      ),
    );

  const byWeek = new Map<string, { meters: number; runs: number }>();
  let longestRunM = 0;
  for (const r of runs) {
    const meters = r.distanceM ?? 0;
    if (meters > longestRunM) longestRunM = meters;
    const key = mondayKey(r.date);
    const cur = byWeek.get(key) ?? { meters: 0, runs: 0 };
    cur.meters += meters;
    if (meters > 0) cur.runs += 1;
    byWeek.set(key, cur);
  }

  const weeklyMileage = [...byWeek.entries()]
    .map(([weekStart, v]) => ({
      weekStart,
      miles: Math.round((v.meters / METERS_PER_MILE) * 10) / 10,
      runs: v.runs,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const milesArr = weeklyMileage.map((w) => w.miles).filter((m) => m > 0);
  const avgWeeklyMiles =
    milesArr.length > 0 ? Math.round((milesArr.reduce((a, b) => a + b, 0) / milesArr.length) * 10) / 10 : null;
  const maxWeeklyMiles = milesArr.length > 0 ? Math.max(...milesArr) : null;
  const runDayCounts = weeklyMileage.map((w) => w.runs).filter((n) => n > 0);
  const typicalRunDaysPerWeek =
    runDayCounts.length > 0
      ? Math.round((runDayCounts.reduce((a, b) => a + b, 0) / runDayCounts.length) * 10) / 10
      : null;

  let recovery: AthleteContext["recovery"] = {
    recoveryScore: null,
    hrvRmssdMs: null,
    restingHr: null,
    acwr: null,
  };
  try {
    const snap = await buildRecoverySnapshot(userId);
    recovery = {
      recoveryScore: snap.recoveryScore,
      hrvRmssdMs: snap.hrvRmssdMs,
      restingHr: snap.restingHr,
      acwr: snap.acwr,
    };
  } catch (err) {
    logger.warn({ err, userId }, "athlete context: recovery snapshot failed");
  }

  const [active] = await db
    .select({ name: trainingPlans.name })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.status, "active")));

  const dataQuality: AthleteContext["dataQuality"] =
    milesArr.length === 0 ? "none" : milesArr.length < 3 ? "sparse" : "ok";

  return {
    todayIso,
    trailingWeeks,
    weeklyMileage,
    avgWeeklyMiles,
    maxWeeklyMiles,
    longestRunMiles: longestRunM > 0 ? Math.round((longestRunM / METERS_PER_MILE) * 10) / 10 : null,
    typicalRunDaysPerWeek,
    recovery,
    activePlan: active ? { name: active.name, runCount: 0 } : null,
    dataQuality,
  };
}
