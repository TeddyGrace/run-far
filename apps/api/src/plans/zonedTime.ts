/**
 * Convert a wall-clock date+time in an IANA timezone to a UTC ISO string.
 * Uses iterative offset correction — no external timezone library required.
 */
export function zonedLocalToIso(dateYmd: string, timeHm: string, timeZone: string): string {
  const [y, mo, d] = dateYmd.split("-").map(Number);
  const [hh, mm] = timeHm.split(":").map(Number);
  if (![y, mo, d, hh, mm].every((n) => Number.isFinite(n))) {
    throw new Error(`Invalid date/time: ${dateYmd} ${timeHm}`);
  }

  // Initial guess: treat the wall clock as UTC, then nudge by the zone's offset at that instant.
  let utcMs = Date.UTC(y!, mo! - 1, d!, hh!, mm!, 0);
  for (let i = 0; i < 3; i++) {
    const parts = partsInZone(new Date(utcMs), timeZone);
    const asLocalMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const desiredLocalMs = Date.UTC(y!, mo! - 1, d!, hh!, mm!, 0);
    const delta = desiredLocalMs - asLocalMs;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs).toISOString();
}

/** Calendar date (YYYY-MM-DD) of an instant in the given IANA timezone. */
export function dateYmdInZone(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Current UTC offset string for a timezone, e.g. "-04:00". */
export function offsetStringForZone(timeZone: string, at: Date = new Date()): string {
  const parts = partsInZone(at, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMin = Math.round((asUtc - at.getTime()) / 60_000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

function partsInZone(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") bag[p.type] = p.value;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour === "24" ? "0" : bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

/**
 * Rewrite each run's scheduledAt to the same calendar day (in `timeZone`) at `localTime` (HH:MM).
 * Keeps all other fields intact.
 */
export function shiftRunsToLocalTime<T extends { scheduledAt: string }>(
  runs: T[],
  localTime: string,
  timeZone: string,
): T[] {
  if (!/^\d{2}:\d{2}$/.test(localTime)) {
    throw new Error(`localTime must be HH:MM, got ${localTime}`);
  }
  // Validate timezone early
  try {
    dateYmdInZone(new Date(), timeZone);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }

  return runs.map((run) => {
    const day = dateYmdInZone(new Date(run.scheduledAt), timeZone);
    return { ...run, scheduledAt: zonedLocalToIso(day, localTime, timeZone) };
  });
}
