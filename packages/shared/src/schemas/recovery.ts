import { z } from "zod";

export const scoreStateSchema = z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]);
export type ScoreState = z.infer<typeof scoreStateSchema>;

/** Where an athlete's recovery/sleep/workout data comes from. Whoop is pulled server-side over
 * OAuth; Apple Health has no cloud API and is pushed to us from HealthKit by the iOS app. */
export const healthProviderSchema = z.enum(["whoop", "apple_health"]);
export type HealthProvider = z.infer<typeof healthProviderSchema>;

export const HEALTH_PROVIDER_LABELS: Record<HealthProvider, string> = {
  whoop: "Whoop",
  apple_health: "Apple Health",
};

/** Which HRV computation a reading actually is. Whoop reports RMSSD, Apple Watch reports SDNN;
 * the two have different scales and spreads, so a value is only ever meaningful against a
 * baseline built from the same metric. Surfaced to the client so a number is never labelled
 * with a metric it isn't. */
export const hrvMetricSchema = z.enum(["rmssd", "sdnn"]);
export type HrvMetric = z.infer<typeof hrvMetricSchema>;

export const HRV_METRIC_LABELS: Record<HrvMetric, string> = {
  rmssd: "RMSSD",
  sdnn: "SDNN",
};

/** Who computed a recovery score: the wearable itself, or run-far. Apple Health publishes no
 * recovery score, so for Apple athletes run-far derives one — and says so. */
export const recoveryScoreSourceSchema = z.enum(["provider", "derived"]);
export type RecoveryScoreSource = z.infer<typeof recoveryScoreSourceSchema>;

/** Per-component breakdown behind a derived recovery score: each input's z-score against the
 * athlete's own baseline, the weight it carried, and the 0-100 sub-score it contributed. Sent
 * to the client so a derived score can be explained rather than just asserted. */
export const recoveryScoreComponentSchema = z.object({
  key: z.enum(["hrv", "restingHr", "sleep", "respiratoryRate", "skinTemp"]),
  /** Signed SDs from baseline, oriented so positive is always *better* recovery. */
  z: z.number().nullable(),
  weight: z.number(),
  subScore: z.number().nullable(),
});
export type RecoveryScoreComponent = z.infer<typeof recoveryScoreComponentSchema>;

export const recoveryScoreComponentsSchema = z.object({
  components: z.array(recoveryScoreComponentSchema),
  /** Days of history the baselines were built from — the honest caveat on a young account. */
  baselineDays: z.number().int().nonnegative(),
});
export type RecoveryScoreComponents = z.infer<typeof recoveryScoreComponentsSchema>;

export const recoveryMetricSchema = z.object({
  id: z.string().uuid(),
  // Defaulted rather than required so responses/rows predating the provider seam still parse,
  // the same convention the recommendation snapshot fields use.
  provider: healthProviderSchema.default("whoop"),
  externalId: z.string(),
  cycleId: z.string().nullable(),
  date: z.string(), // ISO date (YYYY-MM-DD)
  recoveryScore: z.number().min(0).max(100).nullable(),
  recoveryScoreSource: recoveryScoreSourceSchema.default("provider"),
  scoreComponents: recoveryScoreComponentsSchema.nullable().optional(),
  // RMSSD or SDNN depending on hrvMetric — see hrvMetricSchema.
  hrvRmssdMs: z.number().nullable(),
  hrvMetric: hrvMetricSchema.default("rmssd"),
  restingHr: z.number().nullable(),
  spo2: z.number().nullable(),
  skinTempC: z.number().nullable(),
  scoreState: scoreStateSchema,
});
export type RecoveryMetric = z.infer<typeof recoveryMetricSchema>;

export const sleepRecordSchema = z.object({
  id: z.string().uuid(),
  provider: healthProviderSchema.default("whoop"),
  externalId: z.string(),
  date: z.string(),
  durationMin: z.number().nullable(),
  efficiencyPct: z.number().nullable(),
  performancePct: z.number().nullable(),
  sleepDebtMin: z.number().nullable(),
  sleepNeedMin: z.number().nullable().optional(),
  respiratoryRate: z.number().nullable(),
  inBedMin: z.number().nullable().optional(),
  lightMin: z.number().nullable().optional(),
  deepMin: z.number().nullable().optional(),
  remMin: z.number().nullable().optional(),
  awakeMin: z.number().nullable().optional(),
});
export type SleepRecord = z.infer<typeof sleepRecordSchema>;

export const zoneDurationsSchema = z.object({
  zone_zero_milli: z.number(),
  zone_one_milli: z.number(),
  zone_two_milli: z.number(),
  zone_three_milli: z.number(),
  zone_four_milli: z.number(),
  zone_five_milli: z.number(),
});

export const workoutSchema = z.object({
  id: z.string().uuid(),
  provider: healthProviderSchema.default("whoop"),
  externalId: z.string(),
  date: z.string(),
  startedAt: z.string().datetime().nullable().optional(),
  durationMin: z.number().nullable().optional(),
  sport: z.string().nullable(),
  // Whoop-only: Apple Health publishes no strain equivalent, so this is null for Apple rows.
  strain: z.number().nullable(),
  avgHr: z.number().nullable(),
  maxHr: z.number().nullable(),
  kilojoules: z.number().nullable(),
  distanceM: z.number().nullable(),
  distanceManual: z.boolean().optional(),
  percentRecorded: z.number().nullable().optional(),
  altitudeGainM: z.number().nullable().optional(),
  altitudeChangeM: z.number().nullable().optional(),
  zoneDurations: zoneDurationsSchema.nullable().optional(),
});
export type Workout = z.infer<typeof workoutSchema>;

// Hand-entered distance for a workout Whoop synced with no distance (e.g. a treadmill run
// with no GPS/footpod). Capped well above any plausible single-run distance.
export const updateWorkoutDistanceSchema = z.object({
  distanceM: z.number().positive().max(200_000),
});
export type UpdateWorkoutDistanceInput = z.infer<typeof updateWorkoutDistanceSchema>;
