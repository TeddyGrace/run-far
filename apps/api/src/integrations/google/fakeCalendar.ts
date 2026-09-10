import type { calendar_v3 } from "googleapis";

/**
 * An in-memory stand-in for Google Calendar, for the sync tests.
 *
 * Deliberately a small stateful *server* rather than a set of canned HTTP responses. The
 * behaviours worth testing in pull.ts and push.ts — loop prevention, app-wins conflict
 * resolution, sync-token deltas — are not properties of any single request; they emerge from a
 * sequence of them, and specifically from Google changing an etag on every write and refusing a
 * write whose If-Match no longer matches. Canned responses would let a test assert that a
 * particular request was made without ever showing that the resulting round trip is correct.
 *
 * What it models, because the code under test depends on it:
 *  - an etag that changes on every write, which is what makes echo detection possible at all;
 *  - `If-Match` returning 412 on a stale etag, which is the trigger for the forced-overwrite path;
 *  - sync tokens as a monotonic version cursor, returning only what changed since;
 *  - deletions surviving in the delta as `status: "cancelled"`, which is how a pull ever learns
 *    about them;
 *  - a 410 for an expired sync token, the case that forces a full resync.
 *
 * What it does not model, because nothing here reads it: recurrence, attendees, reminders,
 * quota errors, or partial failures mid-page.
 */

export interface FakeEvent {
  id: string;
  etag: string;
  status: "confirmed" | "cancelled";
  summary?: string | null;
  description?: string | null;
  start?: calendar_v3.Schema$EventDateTime;
  end?: calendar_v3.Schema$EventDateTime;
  extendedProperties?: { private?: Record<string, string> };
  /** Monotonic write counter — the fake's whole sync-token mechanism. */
  version: number;
}

export interface FakeCalendarOptions {
  /** Force `events.list` to page, so the caller's pagination loop is actually exercised. */
  pageSize?: number;
}

class HttpError extends Error {
  response: { status: number };
  code: number;
  constructor(status: number, message: string) {
    super(message);
    this.response = { status };
    this.code = status;
  }
}

export class FakeGoogleCalendar {
  private calendars = new Map<string, { id: string; summary: string }>();
  private events = new Map<string, FakeEvent>();
  private version = 0;
  private etagSeq = 0;
  /** Sync tokens the fake will reject with a 410, simulating Google expiring one. */
  private expiredTokens = new Set<string>();
  private options: FakeCalendarOptions;

  /** Every call the code under test made, so a test can assert on request shape when the
   * resulting state alone wouldn't show the difference (e.g. that If-Match was sent). */
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = [];

  constructor(options: FakeCalendarOptions = {}) {
    this.options = options;
  }

  // --- Test-side helpers (not part of the Google surface) ---

  /** Simulate someone editing the event directly in Google. Bumps the etag, as Google would. */
  externallyEdit(eventId: string, patch: Partial<Omit<FakeEvent, "id" | "etag" | "version">>): void {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`fake calendar has no event ${eventId}`);
    Object.assign(event, patch, { etag: this.nextEtag(), version: ++this.version });
  }

  /** Simulate someone deleting the event directly in Google. */
  externallyDelete(eventId: string): void {
    this.externallyEdit(eventId, { status: "cancelled" });
  }

  /** Simulate someone creating an event in the Running calendar outside the app. */
  externallyCreate(calendarId: string, event: Partial<FakeEvent> & { id: string }): void {
    this.events.set(event.id, {
      status: "confirmed",
      ...event,
      etag: this.nextEtag(),
      version: ++this.version,
    } as FakeEvent);
    void calendarId;
  }

  expireToken(token: string): void {
    this.expiredTokens.add(token);
  }

  get(eventId: string): FakeEvent | undefined {
    return this.events.get(eventId);
  }

  get liveEventCount(): number {
    return [...this.events.values()].filter((e) => e.status === "confirmed").length;
  }

  private nextEtag(): string {
    return `"etag-${++this.etagSeq}"`;
  }

  // --- The googleapis-shaped surface ---

  /** Drop-in for `google.calendar(...)`. */
  api(): unknown {
    return {
      calendarList: {
        list: async () => {
          this.calls.push({ method: "calendarList.list", args: {} });
          return { data: { items: [...this.calendars.values()] } };
        },
      },
      calendars: {
        insert: async (params: { requestBody: { summary: string } }) => {
          this.calls.push({ method: "calendars.insert", args: { ...params } });
          const id = `cal-${this.calendars.size + 1}`;
          const created = { id, summary: params.requestBody.summary };
          this.calendars.set(id, created);
          return { data: created };
        },
      },
      events: {
        list: async (params: {
          calendarId: string;
          syncToken?: string;
          pageToken?: string;
          singleEvents?: boolean;
        }) => {
          this.calls.push({ method: "events.list", args: { ...params } });
          if (params.syncToken && this.expiredTokens.has(params.syncToken)) {
            throw new HttpError(410, "Sync token is no longer valid");
          }

          const since = params.syncToken ? Number(params.syncToken) : 0;
          // A full sync (no token) doesn't replay deletions — Google simply omits events that
          // no longer exist, rather than reporting them as cancelled.
          const all = [...this.events.values()]
            .filter((e) => e.version > since)
            .filter((e) => params.syncToken != null || e.status !== "cancelled")
            .sort((a, b) => a.version - b.version);

          const offset = params.pageToken ? Number(params.pageToken) : 0;
          // No configured page size means one page containing everything; the `|| 1` keeps
          // slice() sane when there is nothing to return.
          const size = this.options.pageSize ?? (all.length || 1);
          const page = all.slice(offset, offset + size);
          const nextOffset = offset + size;
          const hasMore = nextOffset < all.length;

          return {
            data: {
              items: page.map((e) => this.toWire(e)),
              nextPageToken: hasMore ? String(nextOffset) : undefined,
              // Google only hands back a sync token on the final page.
              nextSyncToken: hasMore ? undefined : String(this.version),
            },
          };
        },

        insert: async (params: { calendarId: string; requestBody: calendar_v3.Schema$Event }) => {
          this.calls.push({ method: "events.insert", args: { ...params } });
          const id = `evt-${this.events.size + 1}`;
          const event: FakeEvent = {
            id,
            etag: this.nextEtag(),
            status: "confirmed",
            summary: params.requestBody.summary,
            description: params.requestBody.description,
            start: params.requestBody.start,
            end: params.requestBody.end,
            extendedProperties: params.requestBody.extendedProperties as FakeEvent["extendedProperties"],
            version: ++this.version,
          };
          this.events.set(id, event);
          return { data: this.toWire(event) };
        },

        update: async (params: {
          calendarId: string;
          eventId: string;
          requestBody: calendar_v3.Schema$Event;
          headers?: Record<string, string>;
        }) => {
          this.calls.push({ method: "events.update", args: { ...params } });
          const event = this.events.get(params.eventId);
          if (!event) throw new HttpError(404, "Not Found");
          // A deleted event is gone as far as an update is concerned. Google is sometimes
          // lenient here (a recently-cancelled event can be revived), but a caller that only
          // works when it is lenient is a caller that breaks once the event ages out — so the
          // fake takes the strict reading.
          if (event.status === "cancelled") throw new HttpError(410, "Resource has been deleted");

          const ifMatch = params.headers?.["If-Match"];
          // The precondition that makes the app-wins path reachable: a caller holding a stale
          // etag is told no rather than silently clobbering whoever wrote last.
          if (ifMatch && ifMatch !== event.etag) throw new HttpError(412, "Precondition Failed");

          Object.assign(event, {
            summary: params.requestBody.summary,
            description: params.requestBody.description,
            start: params.requestBody.start,
            end: params.requestBody.end,
            extendedProperties: params.requestBody.extendedProperties,
            status: "confirmed" as const,
            etag: this.nextEtag(),
            version: ++this.version,
          });
          return { data: this.toWire(event) };
        },

        delete: async (params: { calendarId: string; eventId: string }) => {
          this.calls.push({ method: "events.delete", args: { ...params } });
          const event = this.events.get(params.eventId);
          if (!event || event.status === "cancelled") throw new HttpError(410, "Resource has been deleted");
          event.status = "cancelled";
          event.etag = this.nextEtag();
          event.version = ++this.version;
          return { data: {} };
        },

        watch: async () => ({ data: { id: "chan-1", resourceId: "res-1", expiration: "0" } }),
        stop: async () => ({ data: {} }),
      },
      channels: { stop: async () => ({ data: {} }) },
    };
  }

  private toWire(e: FakeEvent): calendar_v3.Schema$Event {
    return {
      id: e.id,
      etag: e.etag,
      status: e.status,
      summary: e.summary,
      description: e.description,
      start: e.start,
      end: e.end,
      extendedProperties: e.extendedProperties,
    };
  }
}
