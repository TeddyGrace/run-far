import { z } from "zod";

export const scoreStateSchema = z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]);
export type ScoreState = z.infer<typeof scoreStateSchema>;

export const recoveryMetricSchema = z.object({
  id: z.string().uuid(),
  whoopSleepId: z.string(),
  cycleId: z.string().nullable(),
  date: z.string(), // ISO date (YYYY-MM-DD)
  recoveryScore: z.number().min(0).max(100).nullable(),
  hrvRmssdMs: z.number().nullable(),
  restingHr: z.number().nullable(),
  spo2: z.number().nullable(),
  skinTempC: z.number().nullable(),
  scoreState: scoreStateSchema,
});
export type RecoveryMetric = z.infer<typeof recoveryMetricSchema>;

export const sleepRecordSchema = z.object({
  id: z.string().uuid(),
  whoopSleepId: z.string(),
  date: z.string(),
  durationMin: z.number().nullable(),
  efficiencyPct: z.number().nullable(),
  performancePct: z.number().nullable(),
  sleepDebtMin: z.number().nullable(),
  respiratoryRate: z.number().nullable(),
});
export type SleepRecord = z.infer<typeof sleepRecordSchema>;

export const whoopZoneDurationsSchema = z.object({
  zone_zero_milli: z.number(),
  zone_one_milli: z.number(),
  zone_two_milli: z.number(),
  zone_three_milli: z.number(),
  zone_four_milli: z.number(),
  zone_five_milli: z.number(),
});

export const whoopWorkoutSchema = z.object({
  id: z.string().uuid(),
  whoopWorkoutId: z.string(),
  date: z.string(),
  startedAt: z.string().datetime().nullable().optional(),
  durationMin: z.number().nullable().optional(),
  sport: z.string().nullable(),
  strain: z.number().nullable(),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  kilojoules: z.number().nullable(),
  distanceM: z.number().nullable(),
  distanceManual: z.boolean().optional(),
  percentRecorded: z.number().nullable().optional(),
  altitudeGainM: z.number().nullable().optional(),
  altitudeChangeM: z.number().nullable().optional(),
  zoneDurations: whoopZoneDurationsSchema.nullable().optional(),
});
export type WhoopWorkout = z.infer<typeof whoopWorkoutSchema>;

// Hand-entered distance for a workout Whoop synced with no distance (e.g. a treadmill run
// with no GPS/footpod). Capped well above any plausible single-run distance.
export const updateWorkoutDistanceSchema = z.object({
  distanceM: z.number().positive().max(200_000),
});
export type UpdateWorkoutDistanceInput = z.infer<typeof updateWorkoutDistanceSchema>;
