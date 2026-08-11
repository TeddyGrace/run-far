import type { Rule } from "../types.js";
import { redRecoveryHardSession } from "./redRecoveryHardSession.js";
import { yellowRecoveryHardSession } from "./yellowRecoveryHardSession.js";
import { hrvSuppressed } from "./hrvSuppressed.js";
import { sleepDebt } from "./sleepDebt.js";
import { acwrSpike } from "./acwrSpike.js";
import { greenRecoveryEasyDay } from "./greenRecoveryEasyDay.js";
import { calendarConflict } from "./calendarConflict.js";

// Order matters: evaluate() takes the first applicable rule as primary. Red-zone overrides
// take priority over everything else; purely informational nudges (green day, ACWR) sit
// at the bottom so they only ever appear as secondary notes when something else also fires,
// or as the sole (low-stakes) recommendation when nothing more urgent applies.
export const ALL_RULES: Rule[] = [
  redRecoveryHardSession,
  yellowRecoveryHardSession,
  sleepDebt,
  hrvSuppressed,
  calendarConflict,
  acwrSpike,
  greenRecoveryEasyDay,
];
