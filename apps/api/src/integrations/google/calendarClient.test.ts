import { describe, it, expect } from "vitest";
import { isBlockingEvent } from "./calendarClient.js";
import type { calendar_v3 } from "googleapis";

function makeEvent(overrides: Partial<calendar_v3.Schema$Event> = {}): calendar_v3.Schema$Event {
  return {
    id: "evt-1",
    summary: "Test event",
    start: { dateTime: "2026-08-22T14:00:00-04:00" },
    end: { dateTime: "2026-08-22T15:00:00-04:00" },
    ...overrides,
  };
}

describe("isBlockingEvent", () => {
  it("blocks a normal timed, accepted, opaque event", () => {
    expect(isBlockingEvent(makeEvent())).toBe(true);
  });

  it("does not block an all-day event (date-only start, no dateTime)", () => {
    // This is the reported bug: an all-day event has no start.dateTime, only a date-only
    // start.date. The old freebusy-based path couldn't tell this apart from a real meeting.
    const event = makeEvent({ start: { date: "2026-08-22" }, end: { date: "2026-08-23" } });
    expect(isBlockingEvent(event)).toBe(false);
  });

  it("does not block a multi-day date-only event", () => {
    const event = makeEvent({ start: { date: "2026-08-20" }, end: { date: "2026-08-25" } });
    expect(isBlockingEvent(event)).toBe(false);
  });

  it("does not block a cancelled event", () => {
    expect(isBlockingEvent(makeEvent({ status: "cancelled" }))).toBe(false);
  });

  it("does not block an event marked Free (transparent)", () => {
    expect(isBlockingEvent(makeEvent({ transparency: "transparent" }))).toBe(false);
  });

  it("blocks an event with no explicit transparency (defaults to opaque/busy)", () => {
    expect(isBlockingEvent(makeEvent({ transparency: undefined }))).toBe(true);
  });

  it("does not block a birthday event", () => {
    expect(isBlockingEvent(makeEvent({ eventType: "birthday" }))).toBe(false);
  });

  it("does not block a working-location event", () => {
    expect(isBlockingEvent(makeEvent({ eventType: "workingLocation" }))).toBe(false);
  });

  it("does not block an event the user declined", () => {
    const event = makeEvent({
      attendees: [
        { email: "someone-else@example.com", self: false, responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "declined" },
      ],
    });
    expect(isBlockingEvent(event)).toBe(false);
  });

  it("blocks an event the user accepted among other attendees", () => {
    const event = makeEvent({
      attendees: [
        { email: "someone-else@example.com", self: false, responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "accepted" },
      ],
    });
    expect(isBlockingEvent(event)).toBe(true);
  });

  it("blocks an event with no attendees at all (a solo calendar entry)", () => {
    expect(isBlockingEvent(makeEvent({ attendees: undefined }))).toBe(true);
  });
});
