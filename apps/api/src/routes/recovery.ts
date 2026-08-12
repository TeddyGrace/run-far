import type { FastifyInstance } from "fastify";
import { and, eq, gte, desc, count, sql, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, cycles } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { buildRecoverySnapshot } from "../recommendations/snapshot.js";
import { cycleLocalDate, cycleLoad } from "../metrics/cycleMetrics.js";

export async function recoveryRoutes(app: FastifyInstance) {
  // Today's snapshot independent of whether any recommendation rule fired — the dashboard's
  // hero number shouldn't disappear on days nothing needs flagging.
  app.get("/api/recovery/today", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    return buildRecoverySnapshot(userId);
  });

  // One row per Whoop physiological cycle for the last N days, oldest first — exactly what
  // the dashboard's sparklines and strain-vs-load chart need in one call. Cycles (not
  // calendar days) are the unit here: a cycle is wake-to-wake and can cross midnight, so a
  // day-string rollup would double-count or drop data at cycle boundaries. `date` is each
  // cycle's local start date (its own recorded timezone offset, see cycleLocalDate) purely
  // for chart labeling — it is not the aggregation key.
  app.get("/api/recovery/history", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { days } = request.query as { days?: string };
    const windowDays = Math.min(Math.max(Number(days) || 14, 1), 90);
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);

    const cycleRows = await db
      .select()
      .from(cycles)
      .where(and(eq(cycles.userId, userId), gte(cycles.start, cutoff)))
      .orderBy(cycles.start);

    if (cycleRows.length === 0) return [];

    const whoopCycleIds = cycleRows.map((c) => c.whoopCycleId);
    const [recoveryRows, sleepRows] = await Promise.all([
      db
        .select()
        .from(recoveryMetrics)
        .where(and(eq(recoveryMetrics.userId, userId), inArray(recoveryMetrics.cycleId, whoopCycleIds))),
      db
        .select()
        .from(sleepRecords)
        .where(
          and(
            eq(sleepRecords.userId, userId),
            inArray(sleepRecords.cycleId, whoopCycleIds),
            eq(sleepRecords.nap, false),
          ),
        ),
    ]);

    const recoveryByCycle = new Map(
      recoveryRows.filter((r) => r.cycleId != null).map((r) => [r.cycleId as string, r]),
    );
    const sleepByCycle = new Map(
      sleepRows.filter((s) => s.cycleId != null).map((s) => [s.cycleId as string, s]),
    );

    return cycleRows.map((c) => ({
      cycleId: c.whoopCycleId,
      date: cycleLocalDate(c),
      cycleStart: c.start.toISOString(),
      cycleEnd: c.end ? c.end.toISOString() : null,
      strain: c.strain ?? null,
      load: cycleLoad(c),
      recovery: recoveryByCycle.get(c.whoopCycleId) ?? null,
      sleep: sleepByCycle.get(c.whoopCycleId) ?? null,
    }));
  });

  // Individual workouts, newest first — the dashboard's recent-activity cards. Distinct
  // from /history, which is per-cycle rather than per-workout.
  app.get("/api/recovery/activities", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { limit, offset, sport } = request.query as {
      limit?: string;
      offset?: string;
      sport?: string;
    };
    const take = Math.min(Math.max(Number(limit) || 7, 1), 50);
    const skip = Math.min(Math.max(Number(offset) || 0, 0), 500);
    // Comma-separated sport keys, e.g. sport=running,cycling — empty means "all recent".
    const sportFilters = (sport ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const conditions = [eq(whoopWorkouts.userId, userId)];
    if (sportFilters.length === 1) conditions.push(eq(whoopWorkouts.sport, sportFilters[0]!));
    else if (sportFilters.length > 1) conditions.push(inArray(whoopWorkouts.sport, sportFilters));
    const where = and(...conditions);

    const [items, countRows, sportRows] = await Promise.all([
      db
        .select({
          id: whoopWorkouts.id,
          date: whoopWorkouts.date,
          startedAt: whoopWorkouts.startedAt,
          durationMin: whoopWorkouts.durationMin,
          sport: whoopWorkouts.sport,
          strain: whoopWorkouts.strain,
          avgHr: whoopWorkouts.avgHr,
          maxHr: whoopWorkouts.maxHr,
          kilojoules: whoopWorkouts.kilojoules,
          distanceM: whoopWorkouts.distanceM,
          percentRecorded: whoopWorkouts.percentRecorded,
          altitudeGainM: whoopWorkouts.altitudeGainM,
          altitudeChangeM: whoopWorkouts.altitudeChangeM,
          zoneDurations: whoopWorkouts.zoneDurations,
        })
        .from(whoopWorkouts)
        .where(where)
        // Start time is the real ordering within a day; createdAt only reflects sync order.
        // Rows synced before startedAt existed fall back to the end of their day.
        .orderBy(
          desc(whoopWorkouts.date),
          sql`${whoopWorkouts.startedAt} DESC NULLS LAST`,
          desc(whoopWorkouts.createdAt),
        )
        .limit(take)
        .offset(skip),
      db.select({ value: count() }).from(whoopWorkouts).where(where),
      // Distinct sports for the filter chips, independent of the active sport filter.
      db
        .selectDistinct({ sport: whoopWorkouts.sport })
        .from(whoopWorkouts)
        .where(eq(whoopWorkouts.userId, userId))
        .orderBy(whoopWorkouts.sport),
    ]);

    const total = Number(countRows[0]?.value ?? 0);
    return {
      items,
      total,
      hasMore: skip + items.length < total,
      sports: sportRows.map((r) => r.sport).filter((s): s is string => Boolean(s)),
    };
  });
}
