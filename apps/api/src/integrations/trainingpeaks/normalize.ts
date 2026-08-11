/** Unit and format normalization for values pulled out of a TrainingPeaks-style CSV. */

/** Parses a duration cell into minutes. Accepts "45", "45.5", "1:15:00" (H:MM:SS), or "0:45:00". */
export function parseDurationMinutes(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map(Number);
    if (parts.some((p) => Number.isNaN(p))) return null;
    if (parts.length === 3) {
      const [h, m, s] = parts as [number, number, number];
      return h * 60 + m + s / 60;
    }
    if (parts.length === 2) {
      const [m, s] = parts as [number, number];
      return m + s / 60;
    }
    return null;
  }
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/** Parses a distance cell into meters, given an optional explicit unit column value. */
export function parseDistanceMeters(raw: string | undefined, unit?: string): number | null {
  if (!raw || !raw.trim()) return null;
  const num = Number(raw.trim());
  if (!Number.isFinite(num)) return null;

  const normalizedUnit = (unit ?? inferUnitFromMagnitude(num)).toLowerCase();
  switch (normalizedUnit) {
    case "mi":
    case "mile":
    case "miles":
      return num * 1609.344;
    case "km":
    case "kilometer":
    case "kilometers":
      return num * 1000;
    case "m":
    case "meter":
    case "meters":
      return num;
    default:
      // No unit given: TP plan exports commonly store distance in miles or km depending
      // on account locale. Values under ~200 are almost always mi/km, not meters.
      return num < 200 ? num * 1000 : num;
  }
}

function inferUnitFromMagnitude(_num: number): string {
  return ""; // fall through to the default branch in parseDistanceMeters
}

/** Parses a pace cell like "8:30" (min:sec per mile/km) into seconds per km, given a distance unit hint. */
export function parsePaceSecondsPerKm(raw: string | undefined, distanceUnit?: string): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const parts = trimmed.split(":").map(Number);
  if (parts.length !== 2 || parts.some((p) => Number.isNaN(p))) return null;
  const [min, sec] = parts as [number, number];
  const secondsPerUnit = min * 60 + sec;
  const unit = (distanceUnit ?? "mi").toLowerCase();
  if (unit.startsWith("mi")) return secondsPerUnit / 1.609344;
  return secondsPerUnit; // already per km
}

const RUN_TYPE_KEYWORDS: Array<{ keywords: string[]; runType: string }> = [
  { keywords: ["interval", "vo2", "speed", "repetition"], runType: "interval" },
  { keywords: ["tempo", "threshold"], runType: "tempo" },
  { keywords: ["long"], runType: "long" },
  { keywords: ["recovery"], runType: "recovery" },
  { keywords: ["race"], runType: "race" },
  { keywords: ["rest", "day off"], runType: "rest" },
  { keywords: ["easy", "endurance", "aerobic"], runType: "easy" },
];

/**
 * Maps a TP subtype/title/description string to our run_type enum. Falls back to "easy"
 * when nothing matches — the safest default for a rules engine that's more conservative
 * about downgrading hard sessions than about leaving an easy day alone.
 */
export function classifyRunType(...texts: Array<string | undefined>): string {
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  for (const { keywords, runType } of RUN_TYPE_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k))) return runType;
  }
  return "easy";
}
