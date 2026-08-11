import { z } from "zod";

export const recommendationSeveritySchema = z.enum(["info", "yellow", "red"]);
export type RecommendationSeverity = z.infer<typeof recommendationSeveritySchema>;

export const recommendationStatusSchema = z.enum(["pending", "accepted", "dismissed"]);
export type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

export const recoverySnapshotSchema = z.object({
  date: z.string(),
  recoveryScore: z.number().nullable(),
  hrvRmssdMs: z.number().nullable(),
  hrvBaselineMs: z.number().nullable(),
  hrvBaselineSd: z.number().nullable(),
  restingHr: z.number().nullable(),
  restingHrBaseline: z.number().nullable(),
  sleepDebtMin7d: z.number().nullable(),
  strain7d: z.number().nullable(),
  acuteTss7d: z.number().nullable(),
  chronicTss28d: z.number().nullable(),
  acwr: z.number().nullable(),
  // Consecutive days (including today) with HRV >= 1 SD below baseline. A single
  // suppressed day is common noise; the hrv-suppressed rule requires a run of them.
  hrvSuppressedConsecutiveDays: z.number().int().nonnegative(),
});
export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;

export const proposedChangeSchema = z.object({
  plannedRunId: z.string().uuid(),
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type ProposedChange = z.infer<typeof proposedChangeSchema>;

export const recommendationSchema = z.object({
  id: z.string().uuid(),
  date: z.string(),
  ruleId: z.string(),
  severity: recommendationSeveritySchema,
  summary: z.string(),
  reason: z.string(),
  inputSnapshot: recoverySnapshotSchema,
  proposedChanges: z.array(proposedChangeSchema),
  status: recommendationStatusSchema,
  appliedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
