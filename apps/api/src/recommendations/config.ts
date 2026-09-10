import type { ResolvedRuleThresholds } from "@run-far/shared";

/**
 * Shipped defaults for the thresholds an athlete can tune.
 *
 * Rules never read this directly — they read the resolved set off `RuleContext.thresholds`, which
 * is these values with that athlete's overrides applied (see lib/ruleThresholds.ts). Reading the
 * defaults inside a rule would silently ignore whatever the athlete had set, so the constant is
 * exported for the resolver and for tests, not as a convenience.
 *
 * Because overrides are stored sparsely, changing a number here reaches every athlete who has not
 * explicitly moved that one — which is the point of storing them sparsely.
 */
export const DEFAULT_RULE_THRESHOLDS: ResolvedRuleThresholds = {
  recoveryRedMax: 33, // recovery_score <= this => "red" zone
  recoveryYellowMax: 66, // recovery_score <= this (and > red) => "yellow" zone
  hrvSuppressedSd: 1, // HRV this many SDs below baseline counts as "suppressed"
  hrvMinConsecutiveDays: 2, // a single suppressed day is common noise; require a run of them
  sleepDebtThresholdMin: 90, // today's rolling sleep debt (minutes, Whoop's own figure)
  acwrSpikeThreshold: 1.5, // acute:chronic load ratio above this is a ramp-rate warning
  volumeReductionYellowPct: 0.2, // reduce volume/intensity ~20% on a yellow-zone hard day
};

/**
 * Engine mechanics, deliberately *not* per-athlete.
 *
 * The split from DEFAULT_RULE_THRESHOLDS above is the point of this file: those are judgement
 * calls about one athlete's physiology, and reasonable people set them differently. These are
 * correctness and infrastructure — a data-sufficiency guard, a suppression window, a network
 * timeout, a unit conversion. Exposing them as sliders would let an athlete break the engine
 * rather than tune it, so they stay global and stay here.
 */
export const ENGINE_CONFIG = {
  acwr: {
    // Minimum completed cycles required before ACWR is reported at all. The chronic baseline is
    // a 28-cycle sum / 4; with only a handful of cycles that weekly figure is tiny and the ratio
    // explodes into a meaningless "spike", so we withhold ACWR until ~3 weeks of history exist.
    // Not a preference: below this the number is not conservative, it is wrong.
    minChronicCycles: 21,
  },
  suppression: {
    // How long a dismissed/accepted recommendation's content stays suppressed. The fingerprint
    // deliberately excludes `date` so a dismissal survives the day rolling over — but without a
    // window that also means a legitimately recurring situation (the same recurring meeting
    // conflicting with the same run, months later) could never surface again.
    windowDays: 14,
  },
  sources: {
    // Budget for one non-rules source (see sources/index.ts gather()). A model scoring call that
    // blows through this is treated as a failure and yields no outputs, so a slow service can't
    // hold up a dashboard read. Applies per source, not to the whole gather.
    timeoutMs: 2000,
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
