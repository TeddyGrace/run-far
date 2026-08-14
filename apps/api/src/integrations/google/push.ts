import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { plannedRuns, oauthConnections, syncConflicts } from "../../db/schema.js";
import { ensureRunningCalendar, insertEvent, updateEvent, deleteEvent } from "./calendarClient.js";
import type { EventUpsertInput } from "./calendarClient.js";
import { logger } from "../../lib/logger.js";
import { formatMiles } from "../../lib/units.js";

export async function hasGoogleConnection(userId: string): Promise<boolean> {
  const [conn] = await db
    .select({ id: oauthConnections.id })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
  return Boolean(conn);
}

function toEventInput(run: typeof plannedRuns.$inferSelect): EventUpsertInput {
  const durationMin = run.durationMin ?? 30;
  const start = run.scheduledAt;
  const end = new Date(start.getTime() + durationMin * 60_000);
  const distanceMiles = formatMiles(run.distanceM);
  const parts = [run.description, distanceMiles, `${durationMin} min`].filter(Boolean);
  return {
    plannedRunId: run.id,
    summary: `${capitalize(run.runType)} run`,
    description: parts.join(" — "),
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Pushes a planned_runs row's current state to its Google Calendar event (creating one
 * if it doesn't have one yet). Called after any insert/update to planned_runs. A no-op if
 * the user hasn't connected Google.
 */
export async function pushPlannedRunToGoogle(plannedRunId: string, userId: string): Promise<void> {
  if (!(await hasGoogleConnection(userId))) return;

  const [run] = await db
    .select()
    .from(plannedRuns)
    .where(and(eq(plannedRuns.id, plannedRunId), eq(plannedRuns.userId, userId)));
  if (!run) return;

  if (run.runType === "rest") {
    // Rest days aren't real events — never push them, and remove any that were
    // synced before this filter existed.
    if (run.gcalEventId) {
      await deletePlannedRunFromGoogle(run.gcalEventId, userId);
      await db
        .update(plannedRuns)
        .set({ gcalEventId: null, gcalEtag: null })
        .where(eq(plannedRuns.id, run.id));
    }
    return;
  }

  const calendarId = await ensureRunningCalendar(userId);
  const input = toEventInput(run);

  if (!run.gcalEventId) {
    const { eventId, etag } = await insertEvent(userId, calendarId, input);
    await db
      .update(plannedRuns)
      .set({ gcalEventId: eventId, gcalEtag: etag })
      .where(eq(plannedRuns.id, run.id));
    return;
  }

  const result = await updateEvent(userId, calendarId, run.gcalEventId, input, run.gcalEtag ?? undefined);
  if ("conflict" in result) {
    // The stored etag is stale: something changed the event on Google's side since our
    // last write, and we're about to overwrite it. Per the app-wins policy, force the
    // write through (no If-Match) and log what we clobbered for visibility.
    logger.warn({ plannedRunId, userId }, "etag conflict on push — app wins, forcing overwrite");
    const forced = await updateEvent(userId, calendarId, run.gcalEventId, input);
    if ("etag" in forced) {
      await db.insert(syncConflicts).values({
        plannedRunId: run.id,
        appVersion: input as unknown as Record<string, unknown>,
        gcalVersion: { note: "overwritten without being read back; see Google Calendar revision history" },
        resolution: "app_won",
      });
      await db.update(plannedRuns).set({ gcalEtag: forced.etag }).where(eq(plannedRuns.id, run.id));
    }
    return;
  }
  await db.update(plannedRuns).set({ gcalEtag: result.etag }).where(eq(plannedRuns.id, run.id));
}

/** Deletes the Google Calendar event for a planned run being deleted from the app. */
export async function deletePlannedRunFromGoogle(
  gcalEventId: string | null,
  userId: string,
): Promise<void> {
  if (!gcalEventId || !(await hasGoogleConnection(userId))) return;
  const calendarId = await ensureRunningCalendar(userId);
  await deleteEvent(userId, calendarId, gcalEventId);
}
