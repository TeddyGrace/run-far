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
    thresholdMin: 90, // today's rolling sleep debt (minutes, Whoop's own figure) that triggers a shift
  },
  acwr: {
    spikeThreshold: 1.5, // acute:chronic training load ratio above this is a ramp-rate warning
    // Minimum completed cycles required before ACWR is reported at all. The chronic baseline is
    // a 28-cycle sum / 4; with only a handful of cycles that weekly figure is tiny and the ratio
    // explodes into a meaningless "spike", so we withhold ACWR until ~3 weeks of history exist.
    minChronicCycles: 21,
  },
  volumeReduction: {
    yellowPct: 0.2, // reduce volume/intensity ~20% on a yellow-zone hard day
  },
  cycleLoad: {
    // Fallback only, used when a cycle has no kilojoule reading (kilojoule is a real
    // linear measure and is always preferred when present). WHOOP doesn't publish the
    // exact curve behind its 0-21 strain score, so this is our own monotonic
    // approximation, not a WHOOP-documented formula: load = exp(strain / strainToLoadDivisor).
    // Chosen so strain 21 (max) maps to roughly 1000 "load" units.
    strainToLoadDivisor: 3.04,
  },
} as const;

export const HARD_RUN_TYPES = ["tempo", "interval", "long", "race"] as const;
