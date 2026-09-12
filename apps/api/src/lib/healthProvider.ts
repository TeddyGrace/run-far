import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { cycles, recoveryMetrics, sleepRecords, users, workouts } from "../db/schema.js";
import type { HealthProvider } from "@run-far/shared";

/**
 * Which wearable's data the engine reads for a given athlete.
 *
 * Every read of recovery_metrics / sleep_records / cycles / workouts is filtered to one
 * provider, and this is the function that decides which. That filter is not tidiness — it is
 * correctness:
 *
 *   - HRV is not one number. Whoop reports RMSSD; Apple Watch reports SDNN. They are different
 *     computations over the same beat intervals, with different scales and different spreads.
 *     A 30-day baseline built from a mix of the two has a mean and an SD that describe neither,
 *     and every rule in the engine that says "HRV is N SDs below baseline" would then be
 *     comparing a reading against a distribution it isn't drawn from.
 *   - Recovery score is not one number either. Whoop's is Whoop's; Apple publishes none, so for
 *     Apple athletes run-far derives its own (integrations/appleHealth/recoveryScore.ts). The
 *     two are not on a common scale, so a red-recovery threshold tuned against one is
 *     meaningless against the other.
 *   - Workouts would double-count. An athlete wearing a Whoop and an Apple Watch on the same
 *     run produces two workout rows for one run; summing both inflates weekly mileage and the
 *     acute side of ACWR, and hands the reconciliation matcher two candidates for one session.
 *
 * So the model is one active provider per athlete, switchable, with the other provider's rows
 * retained but unread. Switching is not destructive and not a migration: an athlete who goes
 * back to Whoop sees their Whoop history again immediately.
 */
export async function getActiveHealthProvider(userId: string): Promise<HealthProvider> {
  const [row] = await db
    .select({ provider: users.activeHealthProvider })
    .from(users)
    .where(eq(users.id, userId));
  // A missing user row can't happen on an authenticated path, but defaulting rather than
  // throwing keeps a background sweep from dying on a just-deleted account.
  return row?.provider ?? "whoop";
}

/**
 * Whether each provider has data behind it, so the settings picker can warn that switching
 * would leave the dashboard empty rather than letting the athlete discover it afterwards.
 *
 * "Has data" is deliberately "any recovery row ever", not "recent data": an athlete who took a
 * month off their Whoop still has a Whoop history worth switching back to.
 */
export async function getHealthProviderAvailability(
  userId: string,
): Promise<{ whoop: boolean; appleHealth: boolean }> {
  const rows = await db
    .select({ provider: recoveryMetrics.provider, count: sql<number>`count(*)::int` })
    .from(recoveryMetrics)
    .where(eq(recoveryMetrics.userId, userId))
    .groupBy(recoveryMetrics.provider);

  const byProvider = new Map(rows.map((r) => [r.provider, r.count]));
  return {
    whoop: (byProvider.get("whoop") ?? 0) > 0,
    appleHealth: (byProvider.get("apple_health") ?? 0) > 0,
  };
}

/** The sync_state provider key whose watermark covers this data provider. Apple Health's
 * watermark is written by the ingest route rather than by a poller, but it means the same
 * thing: the instant through which our copy of that provider is complete. */
export function syncProviderFor(provider: HealthProvider): "whoop" | "apple_health" {
  return provider === "apple_health" ? "apple_health" : "whoop";
}

/** `where` fragment for the athlete's active provider on each of the four wearable tables.
 * Written as one helper per table so a call site can't accidentally filter by the wrong
 * table's provider column, which reads identically and would silently match nothing. */
export const providerFilter = {
  recovery: (userId: string, provider: HealthProvider) =>
    and(eq(recoveryMetrics.userId, userId), eq(recoveryMetrics.provider, provider)),
  sleep: (userId: string, provider: HealthProvider) =>
    and(eq(sleepRecords.userId, userId), eq(sleepRecords.provider, provider)),
  cycles: (userId: string, provider: HealthProvider) =>
    and(eq(cycles.userId, userId), eq(cycles.provider, provider)),
  workouts: (userId: string, provider: HealthProvider) =>
    and(eq(workouts.userId, userId), eq(workouts.provider, provider)),
};
