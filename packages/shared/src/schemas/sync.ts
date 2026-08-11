import { z } from "zod";

export const oauthProviderSchema = z.enum(["whoop", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

export const connectionStatusSchema = z.object({
  provider: oauthProviderSchema,
  connected: z.boolean(),
  scopes: z.array(z.string()).default([]),
  lastSyncedAt: z.string().nullable(),
});
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const syncConflictSchema = z.object({
  id: z.string().uuid(),
  plannedRunId: z.string().uuid(),
  detectedAt: z.string(),
  appVersion: z.record(z.string(), z.unknown()),
  gcalVersion: z.record(z.string(), z.unknown()),
  resolution: z.literal("app_won"),
});
export type SyncConflict = z.infer<typeof syncConflictSchema>;
