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
  sleepDebtMin: z.number().nullable(),
  respiratoryRate: z.number().nullable(),
});
export type SleepRecord = z.infer<typeof sleepRecordSchema>;

export const whoopWorkoutSchema = z.object({
  id: z.string().uuid(),
  whoopWorkoutId: z.string(),
  date: z.string(),
  sport: z.string().nullable(),
  strain: z.number().nullable(),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  kilojoules: z.number().nullable(),
  distanceM: z.number().nullable(),
});
export type WhoopWorkout = z.infer<typeof whoopWorkoutSchema>;
