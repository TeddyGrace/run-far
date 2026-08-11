import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { plannedRuns, trainingPlans } from "../db/schema.js";

export interface ActivePlanRun {
  scheduledAt: string;
  runType: string;
  durationMin: number | null;
  distanceM: number | null;
  targetPaceSPerKm: number | null;
  plannedTss: number | null;
  description: string | null;
}

export interface ActivePlanSnapshot {
  id: string;
  name: string;
  brief: string | null;
  source: string;
  runCount: number;
  runs: ActivePlanRun[];
}

/** Load the athlete's active plan with all scheduled runs, or null if none. */
export async function getActivePlanSnapshot(userId: string): Promise<ActivePlanSnapshot | null> {
  const [plan] = await db
    .select({
      id: trainingPlans.id,
      name: trainingPlans.name,
      brief: trainingPlans.brief,
      source: trainingPlans.source,
      runCount: sql<number>`(
        select count(*)::int from planned_runs
        where planned_runs.plan_id = ${trainingPlans.id}
      )`,
    })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, userId), eq(trainingPlans.status, "active")))
    .limit(1);

  if (!plan) return null;

  const rows = await db
    .select({
      scheduledAt: plannedRuns.scheduledAt,
      runType: plannedRuns.runType,
      durationMin: plannedRuns.durationMin,
      distanceM: plannedRuns.distanceM,
      targetPaceSPerKm: plannedRuns.targetPaceSPerKm,
      plannedTss: plannedRuns.plannedTss,
      description: plannedRuns.description,
    })
    .from(plannedRuns)
    .where(and(eq(plannedRuns.userId, userId), eq(plannedRuns.planId, plan.id)))
    .orderBy(asc(plannedRuns.scheduledAt));

  return {
    id: plan.id,
    name: plan.name,
    brief: plan.brief,
    source: plan.source,
    runCount: plan.runCount,
    runs: rows.map((r) => ({
      scheduledAt: r.scheduledAt.toISOString(),
      runType: r.runType,
      durationMin: r.durationMin,
      distanceM: r.distanceM,
      targetPaceSPerKm: r.targetPaceSPerKm,
      plannedTss: r.plannedTss,
      description: r.description,
    })),
  };
}
