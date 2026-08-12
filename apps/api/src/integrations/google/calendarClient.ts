import { calendar_v3, google } from "googleapis";
import { getAuthedClient, getConnectionMetadata, setConnectionMetadata } from "./oauth.js";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";

const RUNNING_CALENDAR_SUMMARY = "Running (run-far)";

// Marker stashed in every event we write, so inbound sync can tell "our event, unchanged
// since we wrote it" apart from "our event, edited on the Google side since".
export const SYNC_ORIGIN_KEY = "runFarManaged";
export const PLANNED_RUN_ID_KEY = "runFarPlannedRunId";

async function getCalendarApi(userId: string): Promise<calendar_v3.Calendar> {
  const auth = await getAuthedClient(userId);
  return google.calendar({ version: "v3", auth });
}

/** Creates (once) and returns the id of the dedicated "Running" calendar for this user.
 * The app only ever writes here — never to the user's primary calendar. */
export async function ensureRunningCalendar(userId: string): Promise<string> {
  const meta = await getConnectionMetadata(userId);
  if (meta?.calendarId && typeof meta.calendarId === "string") {
    return meta.calendarId;
  }

  const api = await getCalendarApi(userId);
  const { data: list } = await api.calendarList.list();
  const existing = list.items?.find((c) => c.summary === RUNNING_CALENDAR_SUMMARY);
  let calendarId = existing?.id;

  if (!calendarId) {
    const { data: created } = await api.calendars.insert({
      requestBody: { summary: RUNNING_CALENDAR_SUMMARY, timeZone: "UTC" },
    });
    calendarId = created.id ?? undefined;
  }
  if (!calendarId) throw new Error("Failed to create or find the Running calendar");

  await setConnectionMetadata(userId, { ...meta, calendarId });
  return calendarId;
}

export interface EventUpsertInput {
  plannedRunId: string;
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
}

/** Creates a new event, tagged with our sync markers. Returns the new event id + etag. */
export async function insertEvent(
  userId: string,
  calendarId: string,
  input: EventUpsertInput,
): Promise<{ eventId: string; etag: string }> {
  const api = await getCalendarApi(userId);
  const { data } = await api.events.insert({
    calendarId,
    requestBody: toEventBody(input),
  });
  if (!data.id || !data.etag) throw new Error("Google did not return an event id/etag on insert");
  return { eventId: data.id, etag: data.etag };
}

/** Updates an existing event. Sends If-Match so a stale write fails loudly instead of clobbering
 * a concurrent external edit — callers should treat that failure as a conflict to resolve. */
export async function updateEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  input: EventUpsertInput,
  ifMatchEtag?: string,
): Promise<{ etag: string } | { conflict: true }> {
  const api = await getCalendarApi(userId);
  try {
    const { data } = await api.events.update({
      calendarId,
      eventId,
      requestBody: toEventBody(input),
      ...(ifMatchEtag ? { headers: { "If-Match": ifMatchEtag } } : {}),
    });
    if (!data.etag) throw new Error("Google did not return an etag on update");
    return { etag: data.etag };
  } catch (err: unknown) {
    const status = (err as { code?: number; response?: { status?: number } })?.response?.status;
    if (status === 412) return { conflict: true }; // precondition failed = etag mismatch
    throw err;
  }
}

export async function deleteEvent(userId: string, calendarId: string, eventId: string): Promise<void> {
  const api = await getCalendarApi(userId);
  try {
    await api.events.delete({ calendarId, eventId });
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 410 || status === 404) return; // already gone — fine
    throw err;
  }
}

function toEventBody(input: EventUpsertInput): calendar_v3.Schema$Event {
  return {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.startIso },
    end: { dateTime: input.endIso },
    extendedProperties: {
      private: {
        [SYNC_ORIGIN_KEY]: "true",
        [PLANNED_RUN_ID_KEY]: input.plannedRunId,
      },
    },
  };
}

/** Registers (or re-registers) a push notification channel for this calendar. */
export async function watchCalendar(
  userId: string,
  calendarId: string,
): Promise<{ channelId: string; resourceId: string; expirationMs: number }> {
  if (!env.GOOGLE_WEBHOOK_URL) {
    throw new Error(
      "GOOGLE_WEBHOOK_URL is not set — Google push notifications require a publicly reachable HTTPS URL (use a tunnel in dev)",
    );
  }
  const api = await getCalendarApi(userId);
  const channelId = crypto.randomUUID();
  const { data } = await api.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: env.GOOGLE_WEBHOOK_URL,
      params: { ttl: String(7 * 24 * 60 * 60) }, // max: 7 days
    },
  });
  if (!data.resourceId || !data.expiration) {
    throw new Error("Google did not return resourceId/expiration for the watch channel");
  }
  logger.info({ userId, calendarId, channelId }, "google calendar watch channel registered");
  return { channelId, resourceId: data.resourceId, expirationMs: Number(data.expiration) };
}

export async function stopWatch(userId: string, channelId: string, resourceId: string): Promise<void> {
  const api = await getCalendarApi(userId);
  try {
    await api.channels.stop({ requestBody: { id: channelId, resourceId } });
  } catch (err) {
    logger.warn({ err, channelId }, "failed to stop google watch channel (may already be expired)");
  }
}

/** Busy periods on the user's primary calendar (not the Running calendar) — used by the
 * calendar-conflict recommendation rule to check whether a planned run overlaps something else. */
export async function getPrimaryBusyPeriods(
  userId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<Array<{ start: Date; end: Date }>> {
  const api = await getCalendarApi(userId);
  const { data } = await api.freebusy.query({
    requestBody: { timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: "primary" }] },
  });
  const busy = data.calendars?.primary?.busy ?? [];
  return busy
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }));
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

/** Titled events on the user's primary calendar in a date range — unlike
 * `getPrimaryBusyPeriods` (free/busy only), this keeps the summary/title so callers
 * (the AI assistant) can talk about *what* a conflict is, not just that one exists. */
export async function listPrimaryEvents(
  userId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<CalendarEvent[]> {
  const api = await getCalendarApi(userId);
  const { data } = await api.events.list({
    calendarId: "primary",
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
  });
  return (data.items ?? [])
    .filter((e) => e.start && e.end)
    .map((e) => {
      const allDay = Boolean(e.start!.date);
      return {
        id: e.id ?? "",
        summary: e.summary ?? "(untitled event)",
        start: (e.start!.dateTime ?? e.start!.date)!,
        end: (e.end!.dateTime ?? e.end!.date)!,
        allDay,
      };
    });
}

/** One page of an incremental (or, with no syncToken, full) events.list call. */
export async function listEventsPage(
  userId: string,
  calendarId: string,
  opts: { syncToken?: string; pageToken?: string },
): Promise<calendar_v3.Schema$Events> {
  const api = await getCalendarApi(userId);
  const { data } = await api.events.list({
    calendarId,
    syncToken: opts.syncToken,
    pageToken: opts.pageToken,
    singleEvents: true,
  });
  return data;
}
