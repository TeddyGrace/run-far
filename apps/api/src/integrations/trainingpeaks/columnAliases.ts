/**
 * TrainingPeaks has no personal API, and its CSV export column names aren't consistently
 * documented — they vary by export type (Workout Summary vs. calendar export) and by
 * third-party tools that produce TP-compatible import files. Rather than hardcode one
 * header set, we match against every known alias per logical field. Adapting to a real
 * export you actually have is then a matter of adding aliases here, not rewriting the parser.
 *
 * Known formats covered:
 *  - Absolute-date exports: Date, WorkoutType, Title, PlannedDuration, PlannedDistance,
 *    PlannedTSS, Description, ...
 *  - Relative-day plan-import format used by several TP-compatible tools:
 *    day, sport, subtype, title, duration_minutes, tss, description, phase
 */

export type LogicalField =
  | "day" // relative day number (1-indexed), used instead of an absolute date
  | "date" // absolute date
  | "sport"
  | "subtype" // maps to run_type after normalization
  | "title"
  | "durationMinutes"
  | "distance"
  | "distanceUnit" // mi | km | m, when distance and its unit are separate columns
  | "targetPace"
  | "tss"
  | "description"
  | "phase";

export const COLUMN_ALIASES: Record<LogicalField, string[]> = {
  day: ["day", "Day", "DayNumber", "day_number"],
  date: ["Date", "date", "WorkoutDate", "workout_date", "ScheduledDate"],
  sport: ["sport", "Sport", "WorkoutType", "workout_type", "Type"],
  subtype: ["subtype", "SubType", "Subtype", "WorkoutSubType", "sub_type"],
  title: ["title", "Title", "WorkoutTitle", "Name", "name"],
  durationMinutes: [
    "duration_minutes",
    "DurationMinutes",
    "PlannedDuration",
    "planned_duration",
    "Duration",
    "duration",
  ],
  distance: ["PlannedDistance", "planned_distance", "Distance", "distance", "DistancePlanned"],
  distanceUnit: ["DistanceUnits", "distance_units", "Unit", "unit"],
  targetPace: ["TargetPace", "target_pace", "PlannedPace", "Pace"],
  tss: ["tss", "TSS", "PlannedTSS", "planned_tss"],
  description: ["description", "Description", "Notes", "notes", "Comments"],
  phase: ["phase", "Phase", "TrainingPhase"],
};

/** Builds a lookup from every seen header (lowercased) to its logical field. */
export function buildHeaderMap(headers: string[]): Partial<Record<LogicalField, string>> {
  const lowerToOriginal = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  const result: Partial<Record<LogicalField, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [LogicalField, string[]][]) {
    for (const alias of aliases) {
      const match = lowerToOriginal.get(alias.toLowerCase());
      if (match) {
        result[field] = match;
        break;
      }
    }
  }
  return result;
}
