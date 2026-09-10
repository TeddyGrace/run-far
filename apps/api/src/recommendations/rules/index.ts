import type { Rule } from "../types.js";
import { redRecoveryHardSession } from "./redRecoveryHardSession.js";
import { yellowRecoveryHardSession } from "./yellowRecoveryHardSession.js";
import { hrvSuppressed } from "./hrvSuppressed.js";
import { sleepDebt } from "./sleepDebt.js";
import { acwrSpike } from "./acwrSpike.js";
import { greenRecoveryEasyDay } from "./greenRecoveryEasyDay.js";
import { calendarConflict } from "./calendarConflict.js";
import { weatherAdvisory } from "./weatherAdvisory.js";
import { hardDayDensity } from "./hardDayDensity.js";

// Declared order is evaluate()'s final tiebreaker, applied after severity and after
// actionable-before-advisory. Red-zone overrides come first; purely informational nudges
// (green day, ACWR) sit at the bottom so they only ever appear as secondary notes when
// something else also fires, or as the sole (low-stakes) recommendation when nothing more
// urgent applies.
export const ALL_RULES: Rule[] = [
  redRecoveryHardSession,
  yellowRecoveryHardSession,
  sleepDebt,
  hrvSuppressed,
  calendarConflict,
  weatherAdvisory,
  // Below the reactive rules: those are about today's body and are time-critical, while this is
  // about the shape of the week and keeps just as well if something more urgent owns the
  // headline. Above acwrSpike, which says something similar about accumulated load but proposes
  // nothing — this one names a specific session to change.
  hardDayDensity,
  acwrSpike,
  greenRecoveryEasyDay,
];
