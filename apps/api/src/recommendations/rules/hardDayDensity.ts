import type { Rule, PlannedRunRow } from "../types.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";
import { isHardRun } from "./shared.js";

/**
 * Too many quality days stacked back to back — read off the plan, not off the athlete's body.
 *
 * Every other rule in this engine is reactive: it waits for recovery to drop, HRV to fall, sleep
 * debt to build, and then argues with the session in front of it. That means the earliest the
 * engine can say anything is after the athlete has already absorbed the load that caused it.
 * This one reads the shape of the schedule instead, so it can object to three straight quality
 * days *before* the third one is what makes Thursday's recovery red.
 *
 * It is the live-schedule counterpart to what plans/validate.ts already does at import time.
 * Validation runs once, against a plan as committed; this runs against the plan as it now
 * stands, after a week of drags, swaps and accepted recommendations have moved things around —
 * which is exactly how a sensible plan turns into three hard days in a row without anyone
 * deciding to do that.
 */

/** A calendar day counts as hard if anything quality is scheduled on it. An easy shakeout
 * alongside a tempo does not make the day easy. */
interface HardDay {
  date: string;
  /** The run to point at if this day is the one to change — the first quality session on it. */
  run: PlannedRunRow;
}

function hardDaysInOrder(upcoming: PlannedRunRow[], timeZone: string): HardDay[] {
  const byDate = new Map<string, PlannedRunRow>();
  for (const run of [...upcoming].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())) {
    if (!isHardRun(run)) continue;
    const date = dateYmdInZone(run.scheduledAt, timeZone);
    if (!byDate.has(date)) byDate.set(date, run);
  }
  return [...byDate.entries()]
    .map(([date, run]) => ({ date, run }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Calendar days between two YYYY-MM-DD dates. Plain arithmetic on athlete-local dates, so no
 * timezone is involved — they were bucketed into the athlete's zone before they got here. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** The first run of consecutive hard days longer than the athlete allows, or null. */
function firstOverlongStreak(days: HardDay[], maxAllowed: number): HardDay[] | null {
  let streak: HardDay[] = [];
  for (const day of days) {
    const previous = streak[streak.length - 1];
    // A gap of any size breaks the streak — a day with nothing scheduled is a rest day in
    // practice, and it is precisely the thing that makes the surrounding days sustainable.
    if (previous && daysBetween(previous.date, day.date) === 1) streak.push(day);
    else streak = [day];
    if (streak.length > maxAllowed) return streak;
  }
  return null;
}

export const hardDayDensity: Rule = ({ upcoming, timeZone, now, thresholds }) => {
  const max = thresholds.maxConsecutiveHardDays;
  const today = dateYmdInZone(now, timeZone);

  // Only days from today forward. `upcoming` is already filtered to the lookahead window, but
  // a run earlier today that has already been run shouldn't be counted as a day still to come.
  const days = hardDaysInOrder(upcoming, timeZone).filter((d) => d.date >= today);
  const streak = firstOverlongStreak(days, max);
  if (!streak) return null;

  // Break the block in the middle rather than at either end. Downgrading the first day wastes
  // the day the athlete is freshest for; downgrading the last leaves the hard days still
  // adjacent and just shortens the block. The earlier middle on an even-length streak, so the
  // easy day lands sooner rather than later.
  const target = streak[Math.floor((streak.length - 1) / 2)]!;
  const dayName = (d: HardDay) =>
    new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

  const span = streak.map((d) => `${dayName(d)} (${d.run.runType})`).join(", ");

  return {
    ruleId: "hard-day-density",
    severity: "yellow",
    summary: `${streak.length} hard days in a row — make ${dayName(target)} easy`,
    reason: `Your schedule has ${streak.length} quality sessions on consecutive days: ${span}. Adaptation happens between hard sessions, not during them, and stacking more than ${max} in a row tends to produce a worse version of each rather than more fitness. Making ${dayName(target)}'s ${target.run.runType} an easy day breaks the block in the middle and leaves the sessions on either side of it intact. Nothing in your recovery data has flagged yet — this is about the shape of the week.`,
    proposedChanges: [
      { plannedRunId: target.run.id, field: "runType", from: target.run.runType, to: "easy" },
      {
        plannedRunId: target.run.id,
        field: "targetPaceSPerKm",
        from: target.run.targetPaceSPerKm,
        to: null,
      },
    ],
  };
};
