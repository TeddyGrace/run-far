import { eq, and } from "drizzle-orm";
import type { calendar_v3 } from "googleapis";
import { db } from "../../db/client.js";
import { plannedRuns, syncState, syncConflicts } from "../../db/schema.js";
import { ensureRunningCalendar, listEventsPage, PLANNED_RUN_ID_KEY } from "./calendarClient.js";
import { pushPlannedRunToGoogle } from "./push.js";
import { logger } from "../../lib/logger.js";
import type { RunType } from "@run-far/shared";

async function getGoogleSyncState(userId: string) {
  const [state] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google")));
  return state ?? null;
}

/**
 * Pulls the incremental (or full, on first run / after a 410) delta from Google Calendar
 * and applies it to planned_runs. This is where loop prevention and the app-wins conflict
 * policy live.
 */
export async function pullGoogleCalendarChanges(userId: string): Promise<void> {
  const calendarId = await ensureRunningCalendar(userId);
  const state = await getGoogleSyncState(userId);
  const syncStartedAt = new Date();

  let syncToken = state?.syncToken ?? undefined;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  const events: calendar_v3.Schema$Event[] = [];

  try {
    do {
      const page = await listEventsPage(userId, calendarId, { syncToken, pageToken });
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken ?? undefined;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 410) {
      logger.warn({ userId }, "google sync token expired (410) — clearing and doing a full resync");
      await db
        .update(syncState)
        .set({ syncToken: null })
        .where(and(eq(syncState.userId, userId), eq(syncState.provider, "google")));
      return pullGoogleCalendarChanges(userId); // retry once, from scratch
    }
    throw err;
  }

  for (const event of events) {
    await applyInboundEvent(userId, event, syncStartedAt);
  }

  await db
    .insert(syncState)
    .values({ userId, provider: "google", syncToken: nextSyncToken ?? syncToken ?? null })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { syncToken: nextSyncToken ?? syncToken ?? null, updatedAt: syncStartedAt },
    });

  logger.info({ userId, eventCount: events.length }, "google calendar pull complete");
}

async function applyInboundEvent(
  userId: string,
  event: calendar_v3.Schema$Event,
  syncStartedAt: Date,
): Promise<void> {
  if (!event.id) return;
  const plannedRunId = event.extendedProperties?.private?.[PLANNED_RUN_ID_KEY];

  const [existing] = plannedRunId
    ? await db.select().from(plannedRuns).where(eq(plannedRuns.id, plannedRunId))
    : await db.select().from(plannedRuns).where(eq(plannedRuns.gcalEventId, event.id));

  // Loop prevention: if this event's etag matches what we last wrote, it's an echo of our
  // own push, not an external change — nothing to do.
  if (existing && existing.gcalEtag === event.etag) return;

  const lastSyncedAt = existing?.updatedAt;
  const state = await getGoogleSyncState(userId);
  const localChangedSinceLastSync =
    existing != null && state?.updatedAt != null && existing.updatedAt > state.updatedAt;

  if (event.status === "cancelled") {
    if (!existing) return; // deleted an event we never tracked; nothing to do
    if (localChangedSinceLastSync) {
      // Conflict: app edited this run after the last sync, Google says it was deleted.
      // App wins — recreate/push the current app version instead of deleting it.
      await logConflict(existing.id, existing, { status: "cancelled" });
      await pushPlannedRunToGoogle(existing.id, userId);
      return;
    }
    await db.delete(plannedRuns).where(eq(plannedRuns.id, existing.id));
    return;
  }

  const startIso = event.start?.dateTime ?? event.start?.date;
  if (!startIso) return;
  const scheduledAt = new Date(startIso);
  const endIso = event.end?.dateTime ?? event.end?.date;
  const durationMin = endIso ? (new Date(endIso).getTime() - scheduledAt.getTime()) / 60_000 : null;

  if (existing) {
    if (localChangedSinceLastSync) {
      // Conflict: both sides changed since the last sync. App wins — push the app's
      // current version back to Google (overwriting the external edit) and log it.
      await logConflict(existing.id, existing, event as unknown as Record<string, unknown>);
      await pushPlannedRunToGoogle(existing.id, userId);
      return;
    }
    await db
      .update(plannedRuns)
      .set({
        scheduledAt,
        durationMin: durationMin ?? existing.durationMin,
        gcalEtag: event.etag ?? existing.gcalEtag,
        status: "moved",
        updatedAt: syncStartedAt,
      })
      .where(eq(plannedRuns.id, existing.id));
    return;
  }

  // A brand-new event created directly in the Running calendar (not through the app).
  // Two-way sync means this should show up as a planned run too.
  await db.insert(plannedRuns).values({
    userId,
    planId: null,
    scheduledAt,
    durationMin,
    distanceM: null,
    runType: guessRunTypeFromSummary(event.summary),
    targetPaceSPerKm: null,
    plannedTss: null,
    description: event.description ?? event.summary ?? null,
    structure: null,
    status: "planned",
    gcalEventId: event.id,
    gcalEtag: event.etag ?? null,
    origin: "manual",
  });
  void lastSyncedAt; // retained for readability of the branch above; not otherwise used
}

function guessRunTypeFromSummary(summary?: string | null): RunType {
  const s = (summary ?? "").toLowerCase();
  if (s.includes("tempo")) return "tempo";
  if (s.includes("interval")) return "interval";
  if (s.includes("long")) return "long";
  if (s.includes("recovery")) return "recovery";
  if (s.includes("race")) return "race";
  if (s.includes("rest")) return "rest";
  return "easy";
}

async function logConflict(
  plannedRunId: string,
  appVersion: unknown,
  gcalVersion: unknown,
): Promise<void> {
  await db.insert(syncConflicts).values({
    plannedRunId,
    appVersion: appVersion as Record<string, unknown>,
    gcalVersion: gcalVersion as Record<string, unknown>,
    resolution: "app_won",
  });
}
