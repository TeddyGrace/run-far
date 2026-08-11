import type { FastifyInstance } from "fastify";
import { and, eq, gte, lte, desc, count, sql, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { buildRecoverySnapshot } from "../recommendations/snapshot.js";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

export async function recoveryRoutes(app: FastifyInstance) {
  // Today's snapshot independent of whether any recommendation rule fired — the dashboard's
  // hero number shouldn't disappear on days nothing needs flagging.
  app.get("/api/recovery/today", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    return buildRecoverySnapshot(userId);
  });

  // Merged recovery + sleep + workout rows for the last N days, oldest first — exactly
  // what the dashboard's sparklines and strain-vs-load chart need in one call.
  app.get("/api/recovery/history", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { days } = request.query as { days?: string };
    const windowDays = Math.min(Math.max(Number(days) || 14, 1), 90);
    const startIso = isoDate(daysAgo(windowDays - 1));
    const endIso = isoDate(new Date());

    const [recoveryRows, sleepRows, workoutRows] = await Promise.all([
      db
        .select()
        .from(recoveryMetrics)
        .where(and(eq(recoveryMetrics.userId, userId), gte(recoveryMetrics.date, startIso), lte(recoveryMetrics.date, endIso)))
        .orderBy(desc(recoveryMetrics.date)),
      db
        .select()
        .from(sleepRecords)
        .where(and(eq(sleepRecords.userId, userId), gte(sleepRecords.date, startIso), lte(sleepRecords.date, endIso)))
        .orderBy(desc(sleepRecords.date)),
      db
        .select()
        .from(whoopWorkouts)
        .where(and(eq(whoopWorkouts.userId, userId), gte(whoopWorkouts.date, startIso), lte(whoopWorkouts.date, endIso)))
        .orderBy(desc(whoopWorkouts.date)),
    ]);

    const byDate = new Map<
      string,
      { date: string; recovery: (typeof recoveryRows)[number] | null; sleep: (typeof sleepRows)[number] | null; strain: number | null }
    >();
    for (const r of recoveryRows) {
      byDate.set(r.date, { date: r.date, recovery: r, sleep: null, strain: null });
    }
    for (const s of sleepRows) {
      const entry = byDate.get(s.date) ?? { date: s.date, recovery: null, sleep: null, strain: null };
      entry.sleep = s;
      byDate.set(s.date, entry);
    }
    for (const w of workoutRows) {
      const entry = byDate.get(w.date) ?? { date: w.date, recovery: null, sleep: null, strain: null };
      entry.strain = (entry.strain ?? 0) + (w.strain ?? 0);
      byDate.set(w.date, entry);
    }

    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  });

  // Individual workouts, newest first — the dashboard's recent-activity cards. Distinct
  // from /history, which collapses workouts into one strain total per day.
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
