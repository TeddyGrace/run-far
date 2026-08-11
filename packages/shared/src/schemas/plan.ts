import { z } from "zod";

export const runTypeSchema = z.enum([
  "easy",
  "tempo",
  "interval",
  "long",
  "recovery",
  "race",
  "rest",
]);
export type RunType = z.infer<typeof runTypeSchema>;

export const runStatusSchema = z.enum(["planned", "completed", "skipped", "moved"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runOriginSchema = z.enum(["imported", "manual", "recommendation"]);
export type RunOrigin = z.infer<typeof runOriginSchema>;

export const runIntervalSchema = z.object({
  label: z.string().optional(),
  repeat: z.number().int().positive().default(1),
  durationSec: z.number().positive().optional(),
  distanceM: z.number().positive().optional(),
  targetPaceSPerKm: z.number().positive().optional(),
  restSec: z.number().nonnegative().optional(),
});
export type RunInterval = z.infer<typeof runIntervalSchema>;

export const runStructureSchema = z.object({
  intervals: z.array(runIntervalSchema).default([]),
});
export type RunStructure = z.infer<typeof runStructureSchema>;

export const plannedRunSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid().nullable(),
  scheduledAt: z.string(), // ISO datetime
  durationMin: z.number().nullable(),
  distanceM: z.number().nullable(),
  runType: runTypeSchema,
  targetPaceSPerKm: z.number().nullable(),
  plannedTss: z.number().nullable(),
  description: z.string().nullable(),
  structure: runStructureSchema.nullable(),
  status: runStatusSchema,
  gcalEventId: z.string().nullable(),
  gcalEtag: z.string().nullable(),
  origin: runOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlannedRun = z.infer<typeof plannedRunSchema>;

export const createPlannedRunSchema = plannedRunSchema.omit({
  id: true,
  gcalEventId: true,
  gcalEtag: true,
  createdAt: true,
  updatedAt: true,
});
export type CreatePlannedRunInput = z.infer<typeof createPlannedRunSchema>;

export const updatePlannedRunSchema = createPlannedRunSchema.partial();
export type UpdatePlannedRunInput = z.infer<typeof updatePlannedRunSchema>;

export const trainingPlanSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  source: z.literal("trainingpeaks_csv"),
  importedAt: z.string(),
});
export type TrainingPlan = z.infer<typeof trainingPlanSchema>;

// --- CSV import preview ---

export const importRowWarningSchema = z.object({
  rowIndex: z.number().int(),
  field: z.string().optional(),
  message: z.string(),
});
export type ImportRowWarning = z.infer<typeof importRowWarningSchema>;

export const importPreviewRowSchema = z.object({
  rowIndex: z.number().int(),
  scheduledAt: z.string().nullable(),
  runType: runTypeSchema.nullable(),
  durationMin: z.number().nullable(),
  distanceM: z.number().nullable(),
  targetPaceSPerKm: z.number().nullable(),
  plannedTss: z.number().nullable(),
  description: z.string().nullable(),
  warnings: z.array(importRowWarningSchema),
});
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;

export const importPreviewSchema = z.object({
  uploadToken: z.string(),
  planName: z.string(),
  rows: z.array(importPreviewRowSchema),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const commitImportSchema = z.object({
  uploadToken: z.string(),
  planName: z.string(),
  // rows the user chose to keep, indexed by rowIndex from the preview
  includeRowIndexes: z.array(z.number().int()).optional(),
});
export type CommitImportInput = z.infer<typeof commitImportSchema>;
