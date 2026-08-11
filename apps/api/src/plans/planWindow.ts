const DAY_MS = 86_400_000;

export interface PlanWeek {
  weekIndex: number;
  monday: string; // YYYY-MM-DD (UTC)
  sunday: string; // YYYY-MM-DD (UTC)
}

export interface PlanWindow {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (race/goal day if provided, else last full week's Sunday)
  todayIso: string;
  totalDays: number;
  completeWeeks: number;
  leftoverDays: number;
  hasRace: boolean;
  weeks: PlanWeek[];
  notes: string[];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a YYYY-MM-DD (or ISO datetime) string to a UTC-midnight Date. */
function parseUtcDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function nextMonday(from: Date): Date {
  const day = from.getUTCDay(); // 0 Sun .. 6 Sat
  const delta = (8 - day) % 7 || 7; // strictly the *next* Monday
  return new Date(from.getTime() + delta * DAY_MS);
}

function mondayOnOrAfter(from: Date): Date {
  const day = from.getUTCDay();
  const delta = (8 - day) % 7; // 0 if already Monday
  return new Date(from.getTime() + delta * DAY_MS);
}

/**
 * Deterministic date math for training plans. The LLM supplies intent (start preference,
 * race/goal date); this function owns the calendar so weeks and counts are never hallucinated.
 */
export function computePlanWindow(input: {
  today: Date;
  startDate?: string;
  raceDate?: string;
  goalDate?: string;
  preferStart?: "today" | "tomorrow" | "next_monday";
}): { ok: true; window: PlanWindow } | { ok: false; error: string } {
  const today = new Date(
    Date.UTC(input.today.getUTCFullYear(), input.today.getUTCMonth(), input.today.getUTCDate()),
  );
  const notes: string[] = [];

  let start: Date;
  if (input.startDate) {
    const parsed = parseUtcDay(input.startDate);
    if (!parsed) return { ok: false, error: `Invalid startDate "${input.startDate}"` };
    start = parsed;
  } else {
    switch (input.preferStart) {
      case "today":
        start = today;
        break;
      case "next_monday":
        start = nextMonday(today);
        break;
      case "tomorrow":
      default:
        start = new Date(today.getTime() + DAY_MS);
    }
  }

  if (start.getTime() < today.getTime()) {
    notes.push("startDate is in the past; clamped to today.");
    start = today;
  }

  const endTarget = input.raceDate ?? input.goalDate;
  let end: Date;
  const hasRace = Boolean(input.raceDate);

  if (endTarget) {
    const parsed = parseUtcDay(endTarget);
    if (!parsed) return { ok: false, error: `Invalid ${input.raceDate ? "raceDate" : "goalDate"} "${endTarget}"` };
    end = parsed;
    if (end.getTime() < start.getTime()) {
      return { ok: false, error: "Race/goal date is before the start date." };
    }
  } else {
    // No target: default to an 8-week block ending on a Sunday.
    const firstMonday = mondayOnOrAfter(start);
    end = new Date(firstMonday.getTime() + (8 * 7 - 1) * DAY_MS);
    notes.push("No race/goal date given; defaulted to an 8-week block.");
  }

  const totalDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const completeWeeks = Math.floor(totalDays / 7);
  const leftoverDays = totalDays % 7;

  // Enumerate Mon–Sun training weeks that overlap the window (aligned to calendar weeks).
  const weeks: PlanWeek[] = [];
  let cursor = mondayOnOrAfter(start);
  // Include a leading partial week if the plan starts mid-week.
  if (cursor.getTime() > start.getTime()) {
    const priorMonday = new Date(cursor.getTime() - 7 * DAY_MS);
    weeks.push({
      weekIndex: 0,
      monday: isoDate(priorMonday),
      sunday: isoDate(new Date(priorMonday.getTime() + 6 * DAY_MS)),
    });
  }
  while (cursor.getTime() <= end.getTime()) {
    weeks.push({
      weekIndex: weeks.length,
      monday: isoDate(cursor),
      sunday: isoDate(new Date(cursor.getTime() + 6 * DAY_MS)),
    });
    cursor = new Date(cursor.getTime() + 7 * DAY_MS);
  }

  if (weeks.length > 40) {
    return { ok: false, error: "Window exceeds 40 weeks; pick a nearer race/goal date." };
  }

  return {
    ok: true,
    window: {
      startDate: isoDate(start),
      endDate: isoDate(end),
      todayIso: isoDate(today),
      totalDays,
      completeWeeks,
      leftoverDays,
      hasRace,
      weeks,
      notes,
    },
  };
}
