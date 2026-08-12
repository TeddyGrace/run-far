const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

export function metersToMiles(m: number): number {
  return m / METERS_PER_MILE;
}

export function formatFeet(m: number | null | undefined): string | null {
  if (m == null) return null;
  return `${Math.round(m / METERS_PER_FOOT)} ft`;
}

export function formatMiles(m: number | null | undefined, digits = 1): string | null {
  if (m == null) return null;
  return `${(m / METERS_PER_MILE).toFixed(digits)} mi`;
}

/** "9:43/mi" from seconds-per-kilometer — computed here so the AI never has to convert
 * pace arithmetic itself (it's proven unreliable at doing that consistently in prose). */
export function formatPaceMinPerMile(secPerKm: number | null | undefined): string | null {
  if (secPerKm == null) return null;
  const secPerMile = secPerKm * (METERS_PER_MILE / 1000);
  const totalSec = Math.round(secPerMile);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}/mi`;
}

/** Adds `distanceMiles`/`paceMinPerMile` display fields alongside a run's raw metric
 * fields (distanceM, targetPaceSPerKm), which callers still need verbatim when building
 * tool-call payloads (propose_schedule_changes, shift_run_times, etc). */
export function withImperialRunFields<T extends { distanceM?: number | null; targetPaceSPerKm?: number | null }>(
  run: T,
): T & { distanceMiles: string | null; paceMinPerMile: string | null } {
  return {
    ...run,
    distanceMiles: formatMiles(run.distanceM),
    paceMinPerMile: formatPaceMinPerMile(run.targetPaceSPerKm),
  };
}
