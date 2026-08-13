import type { Rule } from "../types.js";
import type { BusyPeriod } from "../types.js";
import type { PlannedRunRow } from "../types.js";
import type { ProposedChange } from "@run-far/shared";
import { dateYmdInZone, zonedLocalToIso } from "../../lib/zonedTime.js";

function overlaps(runStart: Date, runEnd: Date, busy: BusyPeriod): boolean {
  return runStart < busy.end && runEnd > busy.start;
}

/** Finds the nearest slot (the run's own local calendar day, checked at 30-min increments
 * from 5am-9pm athlete-local time) that doesn't overlap any busy period and has room for the
 * run's duration. Anchored to the athlete's timezone (not UTC) via zonedTime.ts, so both the
 * window and the "day" being searched match what the athlete actually sees on their clock. */
function findNearestOpenSlot(run: PlannedRunRow, busyPeriods: BusyPeriod[], timeZone: string): Date | null {
  const durationMs = (run.durationMin ?? 30) * 60_000;
  const day = dateYmdInZone(run.scheduledAt, timeZone);
  const dayStart = new Date(zonedLocalToIso(day, "05:00", timeZone));
  const dayEnd = new Date(zonedLocalToIso(day, "21:00", timeZone));

  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += 30 * 60_000) {
    const candidateStart = new Date(t);
    const candidateEnd = new Date(t + durationMs);
    if (!busyPeriods.some((b) => overlaps(candidateStart, candidateEnd, b))) {
      return candidateStart;
    }
  }
  return null;
}

/** Every planned run this week that overlaps something on the user's primary calendar:
 * propose the nearest open slot the same day for each one that has a viable slot.
 * `busyPeriods` only contains timed, accepted, opaque events (see `isBlockingEvent` in
 * calendarClient.ts) — all-day events, declined invites, and events marked "Free" never
 * reach this rule. Rest runs are never pushed to Google and occupy no time slot, so they're
 * excluded from conflict detection entirely. */
export const calendarConflict: Rule = ({ upcoming, busyPeriods, timeZone }) => {
  if (busyPeriods.length === 0) return null;

  const conflicting = [...upcoming]
    .filter((run) => run.runType !== "rest")
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .filter((run) => {
      const runStart = run.scheduledAt;
      const runEnd = new Date(runStart.getTime() + (run.durationMin ?? 30) * 60_000);
      return busyPeriods.some((b) => overlaps(runStart, runEnd, b));
    });
  if (conflicting.length === 0) return null;

  const proposedChanges: ProposedChange[] = [];
  const notes: string[] = [];

  for (const run of conflicting) {
    const runStart = run.scheduledAt;
    const dayLabel = runStart.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
    });
    const openSlot = findNearestOpenSlot(run, busyPeriods, timeZone);
    if (!openSlot) {
      notes.push(
        `${dayLabel} ${run.runType} run at ${runStart.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })} overlaps your calendar, and no clear open slot was found that day between 5am and 9pm.`,
      );
      continue;
    }
    notes.push(
      `${dayLabel} ${run.runType} run overlaps your calendar — ${openSlot.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })} looks open and fits the run's duration.`,
    );
    proposedChanges.push({
      plannedRunId: run.id,
      field: "scheduledAt",
      from: runStart.toISOString(),
      to: openSlot.toISOString(),
    });
  }

  // If nothing has a usable proposed change, there's nothing actionable to show — a card
  // that can only be dismissed is pure noise. Still return the note-only summary when at
  // least one run got a proposed slot; the no-slot notes for the rest ride along as context.
  if (proposedChanges.length === 0) return null;

  const summary =
    conflicting.length === 1 && conflicting[0]
      ? `Your ${conflicting[0].runType} run conflicts with your calendar this week`
      : `${conflicting.length} runs this week conflict with your calendar`;

  return {
    ruleId: "calendar-conflict",
    severity: "info",
    summary,
    reason: notes.join(" "),
    proposedChanges,
  };
};
