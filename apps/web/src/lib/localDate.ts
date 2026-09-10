/**
 * Calendar-date helpers anchored to the browser's own timezone.
 *
 * The calendar, the dashboard and the weather cards all speak in *calendar dates*
 * ("2026-09-10"), not instants. Deriving those from `toISOString()` buckets them in UTC,
 * which is a different day from the athlete's for most of the evening in any negative-offset
 * zone — that is what made the calendar mark Thursday as "Today" at 9pm on Wednesday, and
 * what pushed an evening run into the next day's column.
 *
 * The browser zone is the right anchor here: it *is* the athlete's current zone (travel
 * included), and it's the same value `AuthProvider` captures into `users.timezone`, which the
 * API uses to bucket the weather forecast dates these keys are matched against.
 */

/** Calendar date (YYYY-MM-DD) of an instant, in the browser's timezone. */
export function toLocalYmd(instant: Date): string {
  const y = instant.getFullYear();
  const m = instant.getMonth() + 1;
  const d = instant.getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Today's calendar date (YYYY-MM-DD) in the browser's timezone. */
export function todayYmd(now: Date = new Date()): string {
  return toLocalYmd(now);
}

/** Local midnight at the start of a YYYY-MM-DD calendar date. */
export function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0);
}

/**
 * Step a calendar date by whole days. Goes through a local Date rather than adding
 * 86_400_000ms so a DST transition still advances exactly one calendar day.
 */
export function addDaysYmd(ymd: string, days: number): string {
  const d = ymdToLocalDate(ymd);
  d.setDate(d.getDate() + days);
  return toLocalYmd(d);
}

/** The Monday (ISO week start) of the local week containing `ymd`. */
export function mondayYmd(ymd: string): string {
  const d = ymdToLocalDate(ymd);
  return addDaysYmd(ymd, -((d.getDay() + 6) % 7));
}

/** The seven calendar dates, Monday first, of the week `offsetWeeks` from the current one. */
export function localWeekDays(offsetWeeks: number, now: Date = new Date()): string[] {
  const monday = addDaysYmd(mondayYmd(todayYmd(now)), offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(monday, i));
}

/**
 * Move an instant onto another calendar date, keeping its local wall-clock time. Dragging a
 * 6:30am run to Friday must land at 6:30am Friday — shifting the UTC date instead would land
 * it an hour off across a DST boundary, and on the wrong day for a run whose UTC date and
 * local date already disagree.
 */
export function withLocalYmd(instant: Date, ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const moved = new Date(instant);
  moved.setFullYear(y!, m! - 1, d!);
  return moved;
}
