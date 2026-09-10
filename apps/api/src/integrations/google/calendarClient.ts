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

/**
 * Updates an existing event. Sends If-Match so a stale write fails loudly instead of clobbering
 * a concurrent external edit — callers should treat that failure as a conflict to resolve.
 *
 * Distinguishes the two ways a write can fail to land, because the right response differs:
 * `conflict` means the event is there but someone else wrote it since we last read it, and
 * `gone` means there is no longer an event to update at all. Treating the second as an error
 * (which this used to, by rethrowing) meant the app-wins policy quietly stopped applying in the
 * one case it most needs to — an event deleted on the Google side.
 */
export async function updateEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  input: EventUpsertInput,
  ifMatchEtag?: string,
): Promise<{ etag: string } | { conflict: true } | { gone: true }> {
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
    if (status === 404 || status === 410) return { gone: true }; // deleted on the Google side
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

/** An event only counts as a real scheduling commitment if it's timed, accepted, and busy.
 * Excludes all-day/multi-day events (no `dateTime`, only a date-only `date` — Google's
 * freebusy API can't distinguish these from a real meeting and reports them as an opaque
 * 24h busy block, which is what made an all-day event flag every run that day as
 * conflicting), events explicitly marked "Free", cancelled events, and events the user
 * declined. */
export function isBlockingEvent(e: calendar_v3.Schema$Event): boolean {
  if (e.status === "cancelled") return false;
  if (!e.start?.dateTime || !e.end?.dateTime) return false; // all-day / date-only — never a conflict
  if (e.transparency === "transparent") return false; // marked "Free"
  if (e.eventType === "birthday" || e.eventType === "workingLocation") return false;
  const self = e.attendees?.find((a) => a.self);
  if (self?.responseStatus === "declined") return false;
  return true;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

/** Titled events on the user's primary calendar in a date range, filtered to events that
 * represent a real scheduling commitment (see `isBlockingEvent`). This is the single source
 * of truth for "what's on the user's calendar" — both the calendar-conflict recommendation
 * rule and the AI assistant read through this, so they can't disagree about what counts as
 * a conflict. */
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
    showDeleted: false,
  });
  return (data.items ?? [])
    .filter((e) => e.start && e.end && isBlockingEvent(e))
    .map((e) => ({
      id: e.id ?? "",
      summary: e.summary ?? "(untitled event)",
      start: e.start!.dateTime!,
      end: e.end!.dateTime!,
      allDay: false, // isBlockingEvent already excludes all-day/date-only events
    }));
}

/** Busy periods on the user's primary calendar (not the Running calendar) — used by the
 * calendar-conflict recommendation rule to check whether a planned run overlaps something
 * else. Built on `listPrimaryEvents` (rather than the freebusy API) specifically so all-day
 * events, declined invites, and "Free"-marked events are excluded instead of arriving as
 * opaque, unfilterable busy blocks. */
export async function getPrimaryBusyPeriods(
  userId: string,
  timeMinIso: string,
  timeMaxIso: string,
): Promise<BusyPeriod[]> {
  const events = await listPrimaryEvents(userId, timeMinIso, timeMaxIso);
  return events.map((e) => ({ start: new Date(e.start), end: new Date(e.end), summary: e.summary }));
}

export interface BusyPeriod {
  start: Date;
  end: Date;
  summary?: string;
}

/**
 * How long a fetched set of busy periods is reused.
 *
 * Short on purpose. Unlike the weather forecast, this is data the athlete edits themselves —
 * block out a morning, reload the dashboard, expect the conflict to be noticed. Five minutes is
 * the largest window in which that still feels immediate, while collapsing the repeated reloads
 * of a single sitting into one Google call instead of one per page view.
 *
 * There is no push signal to invalidate against: the app's `events.watch` channel covers the
 * dedicated "Running" calendar it writes to, not the primary calendar these periods come from.
 * So the TTL is the whole invalidation story, and it is deliberately measured in minutes.
 */
const BUSY_TTL_MS = 5 * 60_000;

/**
 * Extra span fetched beyond what was asked for.
 *
 * The requested window is always "now through now + lookahead", so it slides forward between
 * calls. Without the pad, a window cached sixty seconds ago would fall a minute short of the
 * one being asked for now and the cache would never hit. A day of slack costs nothing on a
 * single list call and makes every request inside the TTL a hit.
 */
const BUSY_WINDOW_PAD_MS = 24 * 60 * 60 * 1000;

interface BusyCacheEntry {
  fetchedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  periods: BusyPeriod[];
}

/**
 * Process-local, and that is the right scope for it. The entries are small, already-in-memory
 * projections of data this process just fetched, and the cost of a miss on a cold or sibling
 * instance is exactly one Google call — the behaviour before this cache existed. Persisting
 * them would mean a table whose only job is to hold five minutes of someone's calendar.
 */
const busyCache = new Map<string, BusyCacheEntry>();

/** Drop a user's cached periods — used when their Google connection changes underneath us, so
 * a reconnect or revoke doesn't keep serving windows fetched under the old grant. */
export function invalidateBusyPeriods(userId: string): void {
  busyCache.delete(userId);
}

/**
 * `getPrimaryBusyPeriods` with a short TTL, for the recommendation engine.
 *
 * Regenerating recommendations is what a dashboard read does before it answers, so this call sat
 * on the request path and cost a Google API round trip per page view — quota and latency spent
 * to re-fetch a calendar that had almost certainly not changed. Callers that need a guaranteed
 * live read (the assistant's calendar tool) should keep using `getPrimaryBusyPeriods` directly.
 */
export async function getPrimaryBusyPeriodsCached(
  userId: string,
  timeMinIso: string,
  timeMaxIso: string,
  now: Date = new Date(),
): Promise<BusyPeriod[]> {
  const nowMs = now.getTime();
  const startMs = new Date(timeMinIso).getTime();
  const endMs = new Date(timeMaxIso).getTime();

  const hit = busyCache.get(userId);
  // The cached window has to *contain* the requested one, not merely overlap it: a narrower
  // window would be missing events at an edge and read as "nothing scheduled there".
  if (
    hit &&
    nowMs - hit.fetchedAtMs < BUSY_TTL_MS &&
    hit.windowStartMs <= startMs &&
    hit.windowEndMs >= endMs
  ) {
    return hit.periods;
  }

  const paddedEnd = new Date(endMs + BUSY_WINDOW_PAD_MS).toISOString();
  const periods = await getPrimaryBusyPeriods(userId, timeMinIso, paddedEnd);
  busyCache.set(userId, {
    fetchedAtMs: nowMs,
    windowStartMs: startMs,
    windowEndMs: endMs + BUSY_WINDOW_PAD_MS,
    periods,
  });
  return periods;
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
