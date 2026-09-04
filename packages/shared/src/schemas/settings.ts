import { z } from "zod";

// Models selectable per agent. Keep in sync with what's actually available on the
// Anthropic account — this list is intentionally short-lived and hand-maintained.
export const AI_MODEL_OPTIONS = [
  { value: "claude-opus-5", label: "Claude Opus 5" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-fable-5", label: "Claude Fable 5" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
] as const;

export const aiModelSchema = z.enum(
  AI_MODEL_OPTIONS.map((o) => o.value) as [string, ...string[]],
);
export type AiModel = z.infer<typeof aiModelSchema>;

export const userSettingsSchema = z.object({
  assistantModel: z.string().nullable(),
  planModel: z.string().nullable(),
  defaultAssistantModel: z.string(),
  defaultPlanModel: z.string(),
  // Gates whether the web client renders the model picker at all — the server also refuses a
  // non-admin's PATCH of these fields, so this is a UI convenience, not the enforcement point.
  canChooseModel: z.boolean(),
  locationLat: z.number().nullable(),
  locationLon: z.number().nullable(),
  locationUpdatedAt: z.string().nullable(),
  timezone: z.string().nullable(),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateUserSettingsSchema = z.object({
  assistantModel: aiModelSchema.nullable().optional(),
  planModel: aiModelSchema.nullable().optional(),
  locationLat: z.number().min(-90).max(90).nullable().optional(),
  locationLon: z.number().min(-180).max(180).nullable().optional(),
  // IANA zone name, e.g. "America/New_York" — validated server-side (routes/settings.ts)
  // rather than with a regex here, since the only real check is "does Intl accept it".
  timezone: z.string().min(1).nullable().optional(),
});
export type UpdateUserSettingsInput = z.infer<typeof updateUserSettingsSchema>;
