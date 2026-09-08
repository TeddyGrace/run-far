import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, appSettings } from "../db/schema.js";

/** The one and only app_settings row id. */
export const APP_SETTINGS_ID = "singleton";

/** The columns resolveModelRendered needs — a subset so callers can select only these
 * instead of whole rows, mirroring EntitlementInput in lib/entitlement.ts. */
export type ModelRenderingUser = Pick<typeof users.$inferSelect, "modelRenderedOverride">;
export type ModelRenderingSettings = Pick<
  typeof appSettings.$inferSelect,
  "modelRenderedDefault"
>;

/** What a caller sees when app_settings has no row yet (a freshly created database). */
export const DEFAULT_APP_SETTINGS: ModelRenderingSettings = { modelRenderedDefault: false };

/**
 * The single place that answers "should this athlete see model-sourced recommendations?" — the
 * generation path, the GET route and the accept/dismiss guard all call this rather than reading
 * the two columns directly, so the precedence only has to be gotten right once. Same shape and
 * reasoning as resolveEntitlement in lib/entitlement.ts.
 *
 * Per-account override wins in both directions; null means inherit the global default, which is
 * why the column is nullable rather than a boolean defaulting to false — "off" and "not set" are
 * genuinely different states once a global switch exists.
 *
 * This gates rendering only. The model source still runs and is still scored in shadow when this
 * returns false — see planSources() in recommendations/sources/index.ts.
 */
export function resolveModelRendered(
  user: ModelRenderingUser,
  settings: ModelRenderingSettings,
): boolean {
  return user.modelRenderedOverride ?? settings.modelRenderedDefault;
}

/** Reads the singleton settings row, falling back to defaults when it is absent (a freshly
 * created database, or a test that truncated the table). */
export async function loadAppSettings(): Promise<ModelRenderingSettings> {
  const [row] = await db
    .select({ modelRenderedDefault: appSettings.modelRenderedDefault })
    .from(appSettings)
    .where(eq(appSettings.id, APP_SETTINGS_ID));
  return row ?? DEFAULT_APP_SETTINGS;
}

/** Convenience for the generation and route paths: resolves the flag for one athlete in a
 * single call. A missing user resolves to the global default rather than throwing — the caller
 * is always already holding an authenticated session by this point. */
export async function isModelRenderedFor(userId: string): Promise<boolean> {
  const [[user], settings] = await Promise.all([
    db
      .select({ modelRenderedOverride: users.modelRenderedOverride })
      .from(users)
      .where(eq(users.id, userId)),
    loadAppSettings(),
  ]);
  return resolveModelRendered(user ?? { modelRenderedOverride: null }, settings);
}

/** The source ids whose rows may be shown to this athlete. Shadow rows are persisted for
 * scoring but must never be rendered or acted on — see routes/recommendations.ts. */
export async function renderedSourceIdsFor(userId: string): Promise<string[]> {
  return (await isModelRenderedFor(userId)) ? ["rules", "model"] : ["rules"];
}
