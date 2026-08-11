import type { RunType } from "@run-far/shared";

export const HARD_RUN_TYPES: Set<RunType> = new Set(["tempo", "interval", "long", "race"]);

export const RUN_TYPE_OPTIONS: RunType[] = [
  "easy",
  "tempo",
  "interval",
  "long",
  "recovery",
  "race",
  "rest",
];
