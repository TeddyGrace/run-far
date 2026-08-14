import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { cycles } from "../db/schema.js";
import { dateYmdInZone } from "../lib/zonedTime.js";
import { RECOMMENDATION_CONFIG } from "../recommendations/config.js";

type Cycle = typeof cycles.$inferSelect;

/** Most recent `count` cycles for a user, newest first, regardless of completion state. */
export async function getRecentCycles(userId: string, count: number): Promise<Cycle[]> {
  return db
    .select()
    .from(cycles)
    .where(eq(cycles.userId, userId))
    .orderBy(desc(cycles.start))
    .limit(count);
}

/** The athlete's current (most recent, possibly still-open) cycle, or null if none synced yet. */
export async function getCurrentCycle(userId: string): Promise<Cycle | null> {
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.userId, userId))
    .orderBy(desc(cycles.start))
    .limit(1);
  return cycle ?? null;
}

/** Most recent `count` completed (closed) cycles, newest first. Used for rolling windows —
 * an open cycle's strain/kilojoule are still accumulating and would skew a mean/sum low. */
export async function getRecentCompletedCycles(userId: string, count: number): Promise<Cycle[]> {
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.userId, userId), isNotNull(cycles.end)))
    .orderBy(desc(cycles.start))
    .limit(count);
}

/**
 * Fallback-only approximation of linear cardiovascular load from WHOOP's 0-21 strain score,
 * used when a cycle has no kilojoule reading. Not a WHOOP-published formula — see
 * RECOMMENDATION_CONFIG.cycleLoad for the calibration note.
 */
export function strainToLoad(strain: number): number {
  return Math.exp(strain / RECOMMENDATION_CONFIG.cycleLoad.strainToLoadDivisor);
}

/** Linear load for a cycle: kilojoule when present (a real additive energy measure),
 * else the strainToLoad approximation. Null only when both source fields are null. */
export function cycleLoad(cycle: Pick<Cycle, "kilojoule" | "strain">): number | null {
  if (cycle.kilojoule != null) return cycle.kilojoule;
  if (cycle.strain != null) return strainToLoad(cycle.strain);
  return null;
}

/** The cycle's start date in the athlete's local time — the cycle's own recorded
 * timezoneOffset when present (correct across travel/DST), else the caller-supplied fallback
 * (the athlete's configured timezone, resolved once per request via getAthleteTimezone). */
export function cycleLocalDate(cycle: Pick<Cycle, "start" | "timezoneOffset">, fallbackTz: string): string {
  if (cycle.timezoneOffset) {
    return dateYmdInZoneOffset(cycle.start, cycle.timezoneOffset);
  }
  return dateYmdInZone(cycle.start, fallbackTz);
}

/** Calendar date (YYYY-MM-DD) of an instant given a fixed UTC offset string like "-04:00". */
function dateYmdInZoneOffset(instant: Date, offset: string): string {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return dateYmdInZone(instant, "UTC");
  const [, sign, hh, mm] = match;
  const offsetMin = (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  const shifted = new Date(instant.getTime() + offsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}
