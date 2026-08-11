const METERS_PER_MILE = 1609.344;

export function metersToMiles(m: number): number {
  return m / METERS_PER_MILE;
}

export function milesToMeters(mi: number): number {
  return mi * METERS_PER_MILE;
}

/** Format meters as miles for display, e.g. "3.12 mi". */
export function formatMiles(m: number, digits = 2): string {
  return `${metersToMiles(m).toFixed(digits)} mi`;
}

/** Pace as min/mi from duration (minutes) + distance (meters). */
export function formatPacePerMile(durationMin: number, distanceM: number): string | null {
  if (distanceM <= 0 || durationMin <= 0) return null;
  const minPerMile = durationMin / metersToMiles(distanceM);
  const whole = Math.floor(minPerMile);
  const secs = Math.round((minPerMile - whole) * 60);
  return `${whole}:${secs.toString().padStart(2, "0")}/mi`;
}
