import type { Rule } from "../types.js";
import type { BusyPeriod } from "../types.js";
import type { PlannedRunRow } from "../types.js";
import type { ProposedChange } from "@run-far/shared";

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

/** Every planned run this week that overlaps something on the user's primary calendar:
 * propose the nearest open slot the same day for each one that has a viable slot. */
export const calendarConflict: Rule = ({ upcoming, busyPeriods }) => {
  if (busyPeriods.length === 0) return null;

  const conflicting = [...upcoming]
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
    const dayLabel = runStart.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const openSlot = findNearestOpenSlot(run, busyPeriods);
    if (!openSlot) {
      notes.push(
        `${dayLabel} ${run.runType} run at ${runStart.toLocaleTimeString()} overlaps your calendar, and no clear open slot was found that day between 5am and 9pm.`,
      );
      continue;
    }
    notes.push(
      `${dayLabel} ${run.runType} run overlaps your calendar — ${openSlot.toLocaleTimeString()} looks open and fits the run's duration.`,
    );
    proposedChanges.push({
      plannedRunId: run.id,
      field: "scheduledAt",
      from: runStart.toISOString(),
      to: openSlot.toISOString(),
    });
  }

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
