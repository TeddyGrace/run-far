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
  sleepDebtMinToday: z.number().nullable(),
  // @deprecated sum of individual workout strains over a calendar week — physiologically
  // meaningless (strain is a log scale) and superseded by the cycle-based fields below.
  // Kept optional so historical rows already persisted in recommendations.inputSnapshot
  // still parse.
  strain7d: z.number().nullable().optional(),
  // Mean of cycles.strain (Whoop's own 0-21 score) over the last 7 *completed* cycles.
  cycleStrainAvg7d: z.number().nullable(),
  // Linear load (kilojoule, or an approximated fallback) summed over the same cycles —
  // the figure to use for ratio math like ACWR, where summing must be physically valid.
  cycleLoadSum7d: z.number().nullable(),
  // The current (possibly still-open) cycle's strain, reported separately since an
  // in-progress cycle is excluded from the 7-cycle rolling window above.
  cycleStrainToday: z.number().nullable(),
  // How many of the last 7 cycles actually had a strain value — the denominator behind
  // cycleStrainAvg7d, so a thin history (e.g. 3 cycles synced) doesn't read as a full week.
  cyclesCounted7d: z.number().int().nonnegative(),
  acuteTss7d: z.number().nullable(),
  chronicTss28d: z.number().nullable(),
  acwr: z.number().nullable(),
  // Whoop run mileage (meters): calendar week total, and calendar-month weekly average so far.
  runDistanceMThisWeek: z.number().nullable(),
  runDistanceMPerWeekThisMonth: z.number().nullable(),
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
