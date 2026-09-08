import type { Rule } from "../types.js";
import { redRecoveryHardSession } from "./redRecoveryHardSession.js";
import { yellowRecoveryHardSession } from "./yellowRecoveryHardSession.js";
import { hrvSuppressed } from "./hrvSuppressed.js";
import { sleepDebt } from "./sleepDebt.js";
import { acwrSpike } from "./acwrSpike.js";
import { greenRecoveryEasyDay } from "./greenRecoveryEasyDay.js";
import { calendarConflict } from "./calendarConflict.js";
import { weatherAdvisory } from "./weatherAdvisory.js";

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
  acwrSpike,
  greenRecoveryEasyDay,
];
