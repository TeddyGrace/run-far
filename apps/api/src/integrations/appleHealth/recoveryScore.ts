import type { RecoveryScoreComponent, RecoveryScoreComponents } from "@run-far/shared";

import { DEFAULT_RULE_THRESHOLDS } from "../../recommendations/config.js";

/**
 * A recovery score for athletes whose data comes from Apple Health.
 *
 * Whoop ships a 0-100 recovery score and the engine's thresholds (`recoveryRedMax` 33,
 * `recoveryYellowMax` 66) are phrased against it. Apple publishes no equivalent: HealthKit
 * exposes the *inputs* — HRV, resting heart rate, sleep, respiratory rate, wrist temperature —
 * and nothing that combines them. Apple's own "Vitals" feature does something similar inside
 * the Health app, but it is not a HealthKit type and cannot be read.
 *
 * So run-far computes one. This file is that computation, and it is deliberately the most
 * heavily commented thing in the integration, because it is the one place where a number the
 * athlete will act on is invented rather than reported.
 *
 * What it is: a weighted composite of how far today's readings sit from *this athlete's own*
 * trailing baseline, measured in standard deviations, mapped onto 0-100.
 *
 * What it is not: a physiological model, a reimplementation of Whoop's score, or a number
 * comparable to one. Two things follow, and both are enforced elsewhere rather than hoped for:
 *   - Every row records `recovery_score_source = 'derived'`, so a derived score can never be
 *     read as a wearable's own (see db/schema.ts).
 *   - Reads are filtered to one provider, so a derived score is never averaged or compared
 *     against a Whoop score (see lib/healthProvider.ts).
 *
 * The z-score construction is what makes a self-invented score defensible at all: it has no
 * opinion about what a good HRV is, only about what is normal *for this athlete*. An athlete
 * whose SDNN runs at 30ms and one whose runs at 90ms score identically on an ordinary day.
 */

/**
 * Minimum days of usable baseline before a score is produced at all.
 *
 * Below this the SD is estimated from too few points, and a score built on it swings wildly on
 * ordinary variation — which for a new athlete means a red-recovery card, and a real
 * recommendation to abandon a real session, generated out of noise. Returning null instead is
 * not a degraded experience; the rules read a null score as "no opinion" and simply don't fire
 * (see rules/redRecoveryHardSession.ts), which is the correct behaviour when we genuinely do
 * not know yet.
 *
 * 14 is a judgement call, and a global one rather than a tunable: it is a data-sufficiency
 * guard, and an athlete lowering it would not be tuning the engine but breaking it — the same
 * reasoning as ENGINE_CONFIG.acwr.minChronicCycles.
 */
export const MIN_BASELINE_DAYS = 14;

/**
 * Weights over the available components, renormalized to whatever is actually present.
 *
 * HRV dominates because it is the input with the best-established relationship to autonomic
 * recovery and the one an athlete would look at first. Respiratory rate and wrist temperature
 * carry little weight individually: they are illness/strain signals that are strongly
 * informative when they move a lot and mostly noise otherwise, and the SD-based scaling below
 * already lets a large move speak loudly.
 *
 * Renormalization matters more than the numbers. A watch-only sleeper with no wrist-temperature
 * data should get a score built from the four inputs they do have, not a score penalized for
 * the absence of a fifth — so the weights of present components are scaled to sum to 1.
 */
const WEIGHTS: Record<RecoveryScoreComponent["key"], number> = {
  hrv: 0.4,
  restingHr: 0.25,
  sleep: 0.2,
  respiratoryRate: 0.075,
  skinTemp: 0.075,
};

/**
 * Night-to-night sleep variation as a fraction of sleep need, used as the denominator that
 * turns a sleep shortfall into something on the same scale as the other components' z-scores.
 *
 * Sleep is the one input not scored against a measured baseline: an athlete who is chronically
 * under-slept has a *baseline* of being under-slept, and a z-score against it would read their
 * normal deficit as normal recovery. It is scored against need instead, so 12% short of need
 * (about 55 minutes on an 8-hour need) counts as one SD down.
 */
const SLEEP_SD_FRACTION = 0.12;

/**
 * Mapping from composite z to 0-100.
 *
 * The mapping is *derived from the thresholds it will be compared against* rather than picked
 * by feel. The engine's shipped defaults say yellow ends at 66 and red at 33; this file's job
 * is to decide what composite deviation those boundaries should correspond to, and then solve
 * for the curve that puts them there. Two anchors below, two parameters in a logistic, one
 * solution — so the calibration is stated in the terms the engine actually acts on instead of
 * as two opaque constants.
 *
 * Choosing the anchors is the judgement call, and the thing to understand about them is that a
 * *composite* z is far harder to reach than a single metric's. Every component being half an SD
 * down at once is a meaningfully worse day than any one reading being half an SD down, because
 * the components are correlated but not identical. So the anchors sit closer in than
 * single-metric intuition suggests.
 *
 * A logistic rather than a linear map because it saturates: 3 versus 4 SDs below baseline is
 * not something to act on differently, and a linear map would have to clamp anyway.
 *
 * The consequence worth stating plainly: an ordinary day — every reading at baseline, sleep
 * need met, composite z of 0 — lands in the high 80s, and the whole upper range compresses
 * into 88-100. That is deliberate. The score's resolution is concentrated on the downside,
 * because the downside is the half the engine does anything about; there is no decision that
 * turns on the difference between a good day and a slightly better one.
 *
 * Note the thresholds are per-athlete tunable, and moving them does not move this curve — the
 * curve is fixed and the boundaries slide over it. That is the right way round: an athlete
 * lowering recoveryRedMax is saying "warn me less readily", and the score has to keep meaning
 * the same thing for that to be what happens.
 */

/** Composite deviation at which the shipped yellow boundary sits: most of the way to one SD
 * down across the board. */
const YELLOW_ANCHOR_Z = -0.75;
/** …and the red boundary: one and a half SDs down across the board, which in practice means
 * HRV and resting HR both clearly suppressed *and* sleep short. */
const RED_ANCHOR_Z = -1.5;

/** Solve the logistic through the two anchor points above. */
const { steepness: Z_STEEPNESS, midpoint: Z_MIDPOINT } = solveLogistic(
  YELLOW_ANCHOR_Z,
  DEFAULT_RULE_THRESHOLDS.recoveryYellowMax,
  RED_ANCHOR_Z,
  DEFAULT_RULE_THRESHOLDS.recoveryRedMax,
);

function solveLogistic(
  z1: number,
  score1: number,
  z2: number,
  score2: number,
): { steepness: number; midpoint: number } {
  const logit = (score: number) => Math.log(score / (100 - score));
  // logit(score) = steepness * (z - midpoint) at both anchors; subtracting eliminates midpoint.
  const steepness = (logit(score1) - logit(score2)) / (z1 - z2);
  const midpoint = z1 - logit(score1) / steepness;
  return { steepness, midpoint };
}

/** Clamp on any single component's z before weighting. One implausible reading — a 15ms SDNN
 * from a bad contact, a resting HR sampled mid-caffeine — should be able to pull the score
 * down, but not to dominate a composite the other four inputs disagree with. */
const Z_CLAMP = 3;

export interface Baseline {
  mean: number;
  sd: number;
  /** How many readings the mean/SD came from. */
  n: number;
}

export interface RecoveryBaselines {
  hrv: Baseline | null;
  restingHr: Baseline | null;
  respiratoryRate: Baseline | null;
  skinTempC: Baseline | null;
  /** Distinct days of history behind these baselines — the figure MIN_BASELINE_DAYS gates on. */
  days: number;
}

export interface RecoveryReadings {
  hrvMs: number | null;
  restingHr: number | null;
  /** Minutes actually asleep. */
  asleepMin: number | null;
  /** Sleep need this night is measured against — see deriveSleepNeedMin. */
  sleepNeedMin: number | null;
  respiratoryRate: number | null;
  skinTempC: number | null;
}

export interface DerivedRecoveryScore {
  /** 0-100, or null when there isn't enough baseline to say anything honest. */
  score: number | null;
  /** SCORED once a score exists; PENDING_SCORE while baseline is still being collected;
   * UNSCORABLE when the night itself carried none of the inputs (no watch worn). Mirrors
   * Whoop's own score_state vocabulary so the column means one thing for both providers. */
  scoreState: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  /** The per-component working, persisted for audit. Null when nothing could be computed. */
  components: RecoveryScoreComponents | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Standard deviation of a sample, or null when there are too few points for it to mean
 * anything. Returns null rather than 0 for a single point: a 0 SD would make every subsequent
 * z-score infinite. */
export function sampleStats(values: number[]): Baseline | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  // A degenerate SD (every reading identical, which happens with a rounded metric over a short
  // window) can't scale a deviation, so the component drops out rather than blowing up.
  if (!Number.isFinite(sd) || sd <= 0) return null;
  return { mean, sd, n: values.length };
}

/**
 * Sleep need, in minutes.
 *
 * Whoop computes a personalized need from recent strain, sleep debt and naps. Nothing in
 * HealthKit supports that, and guessing at it would be inventing a second number on top of the
 * one this file already invents. So need is the athlete's own habitual sleep — the trailing
 * *upper* range of what they actually get — floored at a baseline adult need.
 *
 * Using a high percentile of their own history rather than the mean is deliberate: the mean of
 * an under-slept athlete's history is an under-slept night, and calling that "need met" would
 * make the sleep component structurally incapable of ever reporting a shortfall.
 */
export function deriveSleepNeedMin(trailingAsleepMin: number[]): number {
  const FLOOR_MIN = 7 * 60;
  const usable = trailingAsleepMin.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (usable.length < 3) return FLOOR_MIN;
  // 75th percentile of what they actually sleep: what they get on the nights nothing is in the
  // way, which is the closest honest stand-in for what they need.
  const idx = Math.min(usable.length - 1, Math.floor(usable.length * 0.75));
  return Math.max(FLOOR_MIN, usable[idx]!);
}

/**
 * Composite the available components into a 0-100 score.
 *
 * Every z is oriented so that positive always means *better* recovered, regardless of which
 * direction the underlying metric moved. Getting that wrong for one input would produce a score
 * that is confidently backwards on exactly the days it matters, so each orientation is spelled
 * out at its site rather than handled by a shared sign convention.
 */
export function deriveRecoveryScore(
  readings: RecoveryReadings,
  baselines: RecoveryBaselines,
): DerivedRecoveryScore {
  const components: RecoveryScoreComponent[] = [];

  const push = (key: RecoveryScoreComponent["key"], z: number | null) => {
    const clamped = z == null ? null : clamp(z, -Z_CLAMP, Z_CLAMP);
    components.push({
      key,
      z: clamped,
      weight: WEIGHTS[key],
      // The 0-100 this component would produce on its own, through the same curve as the
      // composite — so a breakdown can be read on the same scale as the headline number.
      subScore: clamped == null ? null : logistic(clamped),
    });
  };

  // HRV: higher than baseline is better recovered.
  push(
    "hrv",
    readings.hrvMs != null && baselines.hrv ? (readings.hrvMs - baselines.hrv.mean) / baselines.hrv.sd : null,
  );

  // Resting HR: *lower* than baseline is better recovered, so the difference is inverted.
  push(
    "restingHr",
    readings.restingHr != null && baselines.restingHr
      ? (baselines.restingHr.mean - readings.restingHr) / baselines.restingHr.sd
      : null,
  );

  // Sleep: measured against need, not baseline — see SLEEP_SD_FRACTION. Sleeping beyond need
  // contributes positively but is capped by the shared Z_CLAMP, so a 12-hour catch-up night
  // can't manufacture a 99 on its own.
  push(
    "sleep",
    readings.asleepMin != null && readings.sleepNeedMin != null && readings.sleepNeedMin > 0
      ? (readings.asleepMin / readings.sleepNeedMin - 1) / SLEEP_SD_FRACTION
      : null,
  );

  // Respiratory rate: elevated above baseline is the signal (illness, heat strain, alcohol), so
  // inverted like resting HR.
  push(
    "respiratoryRate",
    readings.respiratoryRate != null && baselines.respiratoryRate
      ? (baselines.respiratoryRate.mean - readings.respiratoryRate) / baselines.respiratoryRate.sd
      : null,
  );

  // Wrist temperature: elevated is the illness signal, so inverted. Only the elevated direction
  // is treated as meaningful — a night measuring cooler than baseline is not evidence of better
  // recovery, so the positive side is capped at 0 rather than rewarded.
  push(
    "skinTemp",
    readings.skinTempC != null && baselines.skinTempC
      ? Math.min(0, (baselines.skinTempC.mean - readings.skinTempC) / baselines.skinTempC.sd)
      : null,
  );

  const present = components.filter((c) => c.z != null);
  const payload: RecoveryScoreComponents = { components, baselineDays: baselines.days };

  // Nothing measured at all: the watch wasn't worn. Distinct from "not enough baseline" — no
  // amount of waiting will score this night, which is what UNSCORABLE means.
  if (present.length === 0) {
    return { score: null, scoreState: "UNSCORABLE", components: payload };
  }

  // Enough readings, not yet enough history to interpret them. The row is still written (the
  // raw HRV/RHR are worth keeping, and they are what the baseline is being built from) but it
  // carries no score, and the rules correctly stay silent.
  if (baselines.days < MIN_BASELINE_DAYS) {
    return { score: null, scoreState: "PENDING_SCORE", components: payload };
  }

  // Sleep alone is scored against need rather than a baseline, so it is the one component that
  // is meaningful without history. That makes it possible to have `days >= MIN_BASELINE_DAYS`
  // (from sleep sessions) while every baseline-scored component is still absent — a score built
  // from sleep duration alone would be a sleep score wearing a recovery score's name.
  const hasBaselineScoredComponent = present.some((c) => c.key !== "sleep");
  if (!hasBaselineScoredComponent) {
    return { score: null, scoreState: "PENDING_SCORE", components: payload };
  }

  const weightSum = present.reduce((sum, c) => sum + c.weight, 0);
  const composite = present.reduce((sum, c) => sum + c.weight * (c.z as number), 0) / weightSum;

  return { score: logistic(composite), scoreState: "SCORED", components: payload };
}

/** Composite z → 0-100, rounded to a whole number because that is the precision the score is
 * shown and compared at (`recoveryScore <= recoveryRedMax`); keeping decimals would imply a
 * resolution this estimate does not have. */
function logistic(z: number): number {
  const raw = 100 / (1 + Math.exp(-Z_STEEPNESS * (z - Z_MIDPOINT)));
  return Math.round(clamp(raw, 0, 100));
}
