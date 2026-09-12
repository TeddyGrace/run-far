import { z } from "zod";

export const oauthProviderSchema = z.enum(["whoop", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/** Everything that has a sync watermark, including the one provider that has no OAuth
 * connection behind it: Apple Health is pushed to the API by the iOS app, so it never appears
 * as an oauth_connections row but does have a "complete through" instant. */
export const syncProviderSchema = z.enum(["whoop", "google", "apple_health"]);
export type SyncProvider = z.infer<typeof syncProviderSchema>;

export const connectionStatusSchema = z.object({
  provider: syncProviderSchema,
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
