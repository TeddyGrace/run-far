import type { Rule } from "../types.js";
import { nextRun } from "./shared.js";
import type { BusyPeriod } from "../types.js";
import type { PlannedRunRow } from "../types.js";

function overlaps(runStart: Date, runEnd: Date, busy: BusyPeriod): boolean {
  return runStart < busy.end && runEnd > busy.start;
}

/** Finds the nearest slot (today, checked at 30-min increments from 5am-9pm) that doesn't
 * overlap any busy period and has room for the run's duration. */
function findNearestOpenSlot(run: PlannedRunRow, busyPeriods: BusyPeriod[]): Date | null {
  const durationMs = (run.durationMin ?? 30) * 60_000;
  const dayStart = new Date(run.scheduledAt);
  dayStart.setUTCHours(5, 0, 0, 0);
  const dayEnd = new Date(run.scheduledAt);
  dayEnd.setUTCHours(21, 0, 0, 0);

  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += 30 * 60_000) {
    const candidateStart = new Date(t);
    const candidateEnd = new Date(t + durationMs);
    if (!busyPeriods.some((b) => overlaps(candidateStart, candidateEnd, b))) {
      return candidateStart;
    }
  }
  return null;
}

/** The next planned run overlaps something on the user's primary calendar: propose the
 * nearest open slot the same day. */
export const calendarConflict: Rule = ({ upcoming, busyPeriods }) => {
  if (busyPeriods.length === 0) return null;
  const run = nextRun(upcoming);
  if (!run) return null;

  const runStart = run.scheduledAt;
  const runEnd = new Date(runStart.getTime() + (run.durationMin ?? 30) * 60_000);
  const conflict = busyPeriods.find((b) => overlaps(runStart, runEnd, b));
  if (!conflict) return null;

  const openSlot = findNearestOpenSlot(run, busyPeriods);
  if (!openSlot) {
    return {
      ruleId: "calendar-conflict",
      severity: "info",
      summary: `Your ${run.runType} run conflicts with something on your calendar today`,
      reason: `The planned ${run.runType} run at ${runStart.toLocaleTimeString()} overlaps a busy period on your calendar, and no clear open slot was found today between 5am and 9pm.`,
      proposedChanges: [],
    };
  }

  return {
    ruleId: "calendar-conflict",
    severity: "info",
    summary: `Your ${run.runType} run conflicts with your calendar — move it to ${openSlot.toLocaleTimeString()}`,
    reason: `The planned ${run.runType} run overlaps a busy period on your calendar. ${openSlot.toLocaleTimeString()} looks open today and fits the run's duration.`,
    proposedChanges: [
      { plannedRunId: run.id, field: "scheduledAt", from: runStart.toISOString(), to: openSlot.toISOString() },
    ],
  };
};
