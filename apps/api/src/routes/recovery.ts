import type { FastifyInstance } from "fastify";
import { and, eq, gte, desc, count, sql, inArray } from "drizzle-orm";
import { updateWorkoutDistanceSchema } from "@run-far/shared";
import { db } from "../db/client.js";
import { recoveryMetrics, sleepRecords, workouts, cycles } from "../db/schema.js";
import { requireUserId } from "../lib/session.js";
import { buildRecoverySnapshot } from "../recommendations/snapshot.js";
import { cycleLocalDate, cycleStrainAndLoad } from "../metrics/cycleMetrics.js";
import { getAthleteTimezone } from "../lib/athleteTimezone.js";
import { getActiveHealthProvider, providerFilter } from "../lib/healthProvider.js";

export async function recoveryRoutes(app: FastifyInstance) {
  // Today's snapshot independent of whether any recommendation rule fired — the dashboard's
  // hero number shouldn't disappear on days nothing needs flagging.
  app.get("/api/recovery/today", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    return buildRecoverySnapshot(userId);
  });

  // One row per Whoop physiological cycle for the last N days, oldest first — exactly what
  // the dashboard's sparklines need in one call. Cycles (not calendar days) are the unit
  // here: a cycle is wake-to-wake and can cross midnight, so a day-string rollup would
  // double-count or drop data at cycle boundaries. `date` is each cycle's local start date
  // (its own recorded timezone offset, see cycleLocalDate) purely for chart labeling — it
  // is not the aggregation key.
  app.get("/api/recovery/history", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { days } = request.query as { days?: string };
    const windowDays = Math.min(Math.max(Number(days) || 14, 1), 90);
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
    const tz = await getAthleteTimezone(userId);
    const provider = await getActiveHealthProvider(userId);

    const cycleRows = await db
      .select()
      .from(cycles)
      .where(and(providerFilter.cycles(userId, provider), gte(cycles.start, cutoff)))
      .orderBy(cycles.start);

    if (cycleRows.length === 0) return [];

    const cycleExternalIds = cycleRows.map((c) => c.externalId);
    const [recoveryRows, sleepRows] = await Promise.all([
      db
        .select()
        .from(recoveryMetrics)
        .where(
          and(
            providerFilter.recovery(userId, provider),
            inArray(recoveryMetrics.cycleId, cycleExternalIds),
          ),
        ),
      db
        .select()
        .from(sleepRecords)
        .where(
          and(
            providerFilter.sleep(userId, provider),
            inArray(sleepRecords.cycleId, cycleExternalIds),
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

    return cycleRows.map((c) => {
      // Recovery and sleep are already final for the open (still-in-progress) cycle
      // (recovery is scored at wake) and are still returned; strain/load are gated on
      // completion by cycleStrainAndLoad — see its doc comment.
      const { strain, load } = cycleStrainAndLoad(c);
      return {
        cycleId: c.externalId,
        date: cycleLocalDate(c, tz),
        cycleStart: c.start.toISOString(),
        cycleEnd: c.end ? c.end.toISOString() : null,
        strain,
        load,
        recovery: recoveryByCycle.get(c.externalId) ?? null,
        sleep: sleepByCycle.get(c.externalId) ?? null,
      };
    });
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

    const activityProvider = await getActiveHealthProvider(userId);
    const conditions = [providerFilter.workouts(userId, activityProvider)];
    if (sportFilters.length === 1) conditions.push(eq(workouts.sport, sportFilters[0]!));
    else if (sportFilters.length > 1) conditions.push(inArray(workouts.sport, sportFilters));
    const where = and(...conditions);

    const [items, countRows, sportRows] = await Promise.all([
      db
        .select({
          id: workouts.id,
          date: workouts.date,
          startedAt: workouts.startedAt,
          durationMin: workouts.durationMin,
          sport: workouts.sport,
          strain: workouts.strain,
          avgHr: workouts.avgHr,
          maxHr: workouts.maxHr,
          kilojoules: workouts.kilojoules,
          distanceM: workouts.distanceM,
          distanceManual: workouts.distanceManual,
          percentRecorded: workouts.percentRecorded,
          altitudeGainM: workouts.altitudeGainM,
          altitudeChangeM: workouts.altitudeChangeM,
          zoneDurations: workouts.zoneDurations,
        })
        .from(workouts)
        .where(where)
        // Start time is the real ordering within a day; createdAt only reflects sync order.
        // Rows synced before startedAt existed fall back to the end of their day.
        .orderBy(
          desc(workouts.date),
          sql`${workouts.startedAt} DESC NULLS LAST`,
          desc(workouts.createdAt),
        )
        .limit(take)
        .offset(skip),
      db.select({ value: count() }).from(workouts).where(where),
      // Distinct sports for the filter chips, independent of the active sport filter.
      db
        .selectDistinct({ sport: workouts.sport })
        .from(workouts)
        .where(providerFilter.workouts(userId, activityProvider))
        .orderBy(workouts.sport),
    ]);

    const total = Number(countRows[0]?.value ?? 0);
    return {
      items,
      total,
      hasMore: skip + items.length < total,
      sports: sportRows.map((r) => r.sport).filter((s): s is string => Boolean(s)),
    };
  });

  // Hand-enter distance for a workout the provider synced with no distance (e.g. a treadmill run
  // with no GPS/footpod) — otherwise it silently contributes 0 to weekly mileage forever.
  // Marks distanceManual so a future resync won't blank it back out (see upsertWorkout).
  app.patch("/api/recovery/activities/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const body = updateWorkoutDistanceSchema.parse(request.body);

    const [existing] = await db
      .select({ id: workouts.id })
      .from(workouts)
      .where(and(eq(workouts.id, id), eq(workouts.userId, userId)));
    if (!existing) {
      reply.status(404).send({ error: { message: "Activity not found", code: "NOT_FOUND" } });
      return;
    }

    await db
      .update(workouts)
      .set({ distanceM: body.distanceM, distanceManual: true, updatedAt: new Date() })
      .where(and(eq(workouts.id, id), eq(workouts.userId, userId)));

    return { ok: true, id, distanceM: body.distanceM };
  });
}
