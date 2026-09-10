import { eq } from "drizzle-orm";
import {
  ruleThresholdsSchema,
  thresholdZonesAreOrdered,
  type ResolvedRuleThresholds,
  type RuleThresholds,
} from "@run-far/shared";

import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { DEFAULT_RULE_THRESHOLDS } from "../recommendations/config.js";
import { logger } from "./logger.js";

/**
 * Resolving an athlete's rule thresholds: shipped defaults, with their overrides applied.
 *
 * One place, for the same reason lib/modelRendering.ts is one place — a setting resolved in two
 * places is a setting that eventually disagrees with itself. Rules receive the resolved set on
 * their context and never look at either layer directly.
 */

/** Merge a sparse override over the defaults. Pure, so it can be exercised without a database. */
export function resolveThresholds(override: RuleThresholds | null | undefined): ResolvedRuleThresholds {
  const merged = { ...DEFAULT_RULE_THRESHOLDS };
  if (!override) return merged;
  for (const [key, value] of Object.entries(override)) {
    // An absent or null field means "use the default" — only a real number overrides. Without
    // this guard a null stored by an older client would read as 0, which for recoveryRedMax
    // silently switches the red-zone rule off entirely.
    if (typeof value === "number" && Number.isFinite(value)) {
      (merged as Record<string, number>)[key] = value;
    }
  }
  return merged;
}

/**
 * Parse whatever is in the jsonb column into a sparse override.
 *
 * Tolerant on purpose: the column is athlete-editable data that has already been written, and a
 * row that no longer parses — a field removed from the schema, a value out of range after a
 * range change — must degrade to the defaults rather than fail the dashboard read that found it.
 * Zod's per-field stripping does most of that; the catch covers a column holding something that
 * isn't an object at all.
 */
export function parseStoredThresholds(stored: unknown, userId?: string): RuleThresholds | null {
  if (stored == null) return null;
  const parsed = ruleThresholdsSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  logger.warn(
    { userId, issues: parsed.error.issues },
    "stored rule thresholds failed validation; falling back to defaults",
  );
  return null;
}

export async function getRuleThresholds(userId: string): Promise<ResolvedRuleThresholds> {
  const [row] = await db
    .select({ ruleThresholds: users.ruleThresholds })
    .from(users)
    .where(eq(users.id, userId));
  return resolveThresholds(parseStoredThresholds(row?.ruleThresholds, userId));
}

/** Every override an athlete has actually set, for the settings UI to render against defaults. */
export async function getStoredThresholds(userId: string): Promise<RuleThresholds> {
  const [row] = await db
    .select({ ruleThresholds: users.ruleThresholds })
    .from(users)
    .where(eq(users.id, userId));
  return parseStoredThresholds(row?.ruleThresholds, userId) ?? {};
}

export class ThresholdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThresholdValidationError";
  }
}

/**
 * Apply a patch of threshold changes.
 *
 * `null` for a field removes the override, restoring the shipped default — distinct from omitting
 * the field, which leaves whatever is currently set. Without that distinction an athlete who
 * moved a slider could never get back to the default, only to a number that happens to equal
 * today's default and would then stop tracking it.
 *
 * Validation is against the *resolved* result, not the patch. Red-below-yellow is a relationship
 * between two fields and a patch routinely carries only one of them, so checking the patch alone
 * would happily accept a red line above the athlete's existing yellow one and invert the zones.
 */
export async function updateRuleThresholds(
  userId: string,
  patch: Record<string, number | null>,
): Promise<RuleThresholds> {
  const current = await getStoredThresholds(userId);
  const next: Record<string, number> = { ...current } as Record<string, number>;

  for (const [key, value] of Object.entries(patch)) {
    if (!(key in ruleThresholdsSchema.shape)) {
      throw new ThresholdValidationError(`Unknown threshold "${key}"`);
    }
    if (value === null) delete next[key];
    else next[key] = value;
  }

  const parsed = ruleThresholdsSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ThresholdValidationError(
      `${issue?.path.join(".") ?? "threshold"}: ${issue?.message ?? "invalid value"}`,
    );
  }

  const resolved = resolveThresholds(parsed.data);
  if (!thresholdZonesAreOrdered(resolved.recoveryRedMax, resolved.recoveryYellowMax)) {
    throw new ThresholdValidationError(
      `The red-zone ceiling (${resolved.recoveryRedMax}) must be below the yellow-zone ceiling (${resolved.recoveryYellowMax}).`,
    );
  }

  // An override set to exactly today's default is stored as an override anyway — the athlete
  // chose that number, and it should not silently start tracking a future change to the default.
  // Clearing is how you opt back in, which is what `null` is for.
  await db
    .update(users)
    .set({ ruleThresholds: Object.keys(parsed.data).length > 0 ? parsed.data : null })
    .where(eq(users.id, userId));

  return parsed.data;
}
