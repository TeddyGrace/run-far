/** Tunable thresholds for the recommendation rules engine. Kept in one place so they can
 * be adjusted (or exposed as UI sliders, per the plan) without touching rule logic. */
export const RECOMMENDATION_CONFIG = {
  recovery: {
    redMax: 33, // recovery_score <= this => "red" zone
    yellowMax: 66, // recovery_score <= this (and > redMax) => "yellow" zone
  },
  hrv: {
    suppressedSdThreshold: 1, // HRV this many SDs below baseline counts as "suppressed"
    minConsecutiveDays: 2,
  },
  sleepDebt: {
    thresholdMin7d: 180, // cumulative 7-day sleep debt (minutes) that triggers a shift
  },
  acwr: {
    spikeThreshold: 1.5, // acute:chronic training load ratio above this is a ramp-rate warning
  },
  volumeReduction: {
    yellowPct: 0.2, // reduce volume/intensity ~20% on a yellow-zone hard day
  },
} as const;

export const HARD_RUN_TYPES = ["tempo", "interval", "long", "race"] as const;
