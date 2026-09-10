import { z } from "zod";

import { runTypeSchema, runStatusSchema } from "./plan.js";

/** Who decided a planned run ↔ workout link. Mirrors the `run_match_source` DB enum. */
export const matchSourceSchema = z.enum(["auto", "manual"]);
export type MatchSource = z.infer<typeof matchSourceSchema>;

/** The workout that actually happened, projected down to what a readout needs. */
export const actualWorkoutSchema = z.object({
  id: z.string().uuid(),
  date: z.string(), // YYYY-MM-DD, already bucketed to the athlete's timezone on ingest
  startedAt: z.string().nullable(),
  sport: z.string().nullable(),
  durationMin: z.number().nullable(),
  distanceM: z.number().nullable(),
  strain: z.number().nullable(),
  avgHr: z.number().nullable(),
});
export type ActualWorkout = z.infer<typeof actualWorkoutSchema>;

/**
 * One planned run and what became of it. `actual` is null both for a run nothing matched and
 * for one not yet reconciled — `reconciledAt` is what separates those two, which is why it is
 * on the wire rather than kept server-side.
 */
export const reconciledRunSchema = z.object({
  plannedRunId: z.string().uuid(),
  scheduledAt: z.string(),
  runType: runTypeSchema,
  status: runStatusSchema,
  plannedDistanceM: z.number().nullable(),
  plannedDurationMin: z.number().nullable(),
  matchSource: matchSourceSchema.nullable(),
  reconciledAt: z.string().nullable(),
  actual: actualWorkoutSchema.nullable(),
  /** actual − planned, null when either side is missing. Precomputed so every consumer
   * (dashboard, digest, a future model) reads the same arithmetic. */
  distanceDeltaM: z.number().nullable(),
  durationDeltaMin: z.number().nullable(),
});
export type ReconciledRun = z.infer<typeof reconciledRunSchema>;

export const adherenceByRunTypeSchema = z.object({
  runType: runTypeSchema,
  completed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type AdherenceByRunType = z.infer<typeof adherenceByRunTypeSchema>;

export const adherenceSummarySchema = z.object({
  from: z.string(), // YYYY-MM-DD, athlete-local
  to: z.string(),
  windowDays: z.number().int().positive(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** Neither completed nor skipped: still upcoming, or reconciled to no verdict yet. */
    open: z.number().int().nonnegative(),
  }),
  /** completed / (completed + skipped) — deliberately excludes still-open runs, so a week
   * that has only just started doesn't read as 15% adherence. Null when nothing has settled. */
  completionRate: z.number().nullable(),
  plannedDistanceM: z.number(),
  actualDistanceM: z.number(),
  plannedDurationMin: z.number(),
  actualDurationMin: z.number(),
  byRunType: z.array(adherenceByRunTypeSchema),
});
export type AdherenceSummary = z.infer<typeof adherenceSummarySchema>;

export const adherenceResponseSchema = z.object({
  summary: adherenceSummarySchema,
  runs: z.array(reconciledRunSchema),
  /** Run-sport workouts in the window that no planned run claimed — the other half of a
   * correction UI, since fixing a bad match means picking the right workout from these. */
  unmatchedWorkouts: z.array(actualWorkoutSchema),
});
export type AdherenceResponse = z.infer<typeof adherenceResponseSchema>;

/**
 * Athlete correction of a match. A body with `workoutId` links that workout and marks the run
 * completed; `workoutId: null` with a status unlinks it. Either way the run is stamped
 * `manual`, which is what makes the sweep leave it alone from then on.
 */
export const setRunActualSchema = z
  .object({
    workoutId: z.string().uuid().nullable(),
    status: z.enum(["completed", "skipped", "planned"]).optional(),
  })
  .refine((v) => v.workoutId !== null || v.status !== undefined, {
    message: "Clearing a match requires an explicit status",
  });
export type SetRunActualInput = z.infer<typeof setRunActualSchema>;
