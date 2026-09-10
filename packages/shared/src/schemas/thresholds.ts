import { z } from "zod";

/**
 * The rules engine's tunable thresholds, as an athlete can set them.
 *
 * These are the numbers where "what counts as a red day" is genuinely a judgement rather than a
 * fact. A recovery score of 33 is the right red line for some athletes and far too conservative
 * for others; an HRV suppression run of two days is noise for one and a real signal for another.
 * Holding them as one global constant meant every athlete was being reasoned about with someone
 * else's calibration.
 *
 * Deliberately a *sparse* override: every field is optional, and an absent field means "use the
 * default", not "zero". That is what lets the shipped defaults keep moving — a better red-line
 * default reaches every athlete who never touched the slider, instead of being frozen into a row
 * at signup.
 *
 * Engine mechanics that are not judgement calls live in ENGINE_CONFIG on the API side and are
 * deliberately absent here: how long a dismissal suppresses a card, how long a model source gets
 * before it is treated as failed, how many cycles of history ACWR needs before it means
 * anything, and the strain→load curve. Those are correctness and infrastructure, not preference,
 * and exposing them as sliders would invite an athlete to break the engine rather than tune it.
 */
export const ruleThresholdsSchema = z.object({
  /** recovery_score at or below this is the "red" zone. */
  recoveryRedMax: z.number().int().min(1).max(98).optional(),
  /** recovery_score at or below this (and above red) is the "yellow" zone. */
  recoveryYellowMax: z.number().int().min(2).max(99).optional(),
  /** HRV this many SDs below baseline counts as suppressed. */
  hrvSuppressedSd: z.number().min(0.25).max(4).optional(),
  /** Consecutive suppressed days before the HRV rule fires. */
  hrvMinConsecutiveDays: z.number().int().min(1).max(14).optional(),
  /** Rolling sleep debt, in minutes, that triggers pushing a session out. */
  sleepDebtThresholdMin: z.number().int().min(15).max(600).optional(),
  /** Acute:chronic load ratio above which the ramp-rate warning fires. */
  acwrSpikeThreshold: z.number().min(1.05).max(3).optional(),
  /** Fractional volume/intensity cut proposed on a yellow-zone hard day (0.2 = 20%). */
  volumeReductionYellowPct: z.number().min(0.05).max(0.75).optional(),
});
export type RuleThresholds = z.infer<typeof ruleThresholdsSchema>;

/**
 * A fully-resolved threshold set — defaults with any overrides applied. Every field present.
 * This is what the rules actually read; `RuleThresholds` is only ever the sparse override.
 */
export type ResolvedRuleThresholds = Required<RuleThresholds>;

/**
 * Red must stay strictly below yellow, or the zones invert and every yellow-zone rule becomes
 * unreachable. Checked here rather than on the individual fields because it is a relationship
 * between two of them, and checked against the *resolved* pair on the server (see
 * lib/ruleThresholds.ts) since a PATCH may set only one side of it.
 */
export function thresholdZonesAreOrdered(redMax: number, yellowMax: number): boolean {
  return redMax < yellowMax;
}

export const updateRuleThresholdsSchema = z.object({
  /** Null resets that field to the shipped default, which is distinct from omitting it
   * (leave whatever is currently set). Without the distinction there is no way back to the
   * default once an athlete has moved a slider. */
  thresholds: z.record(z.string(), z.number().nullable()),
});
export type UpdateRuleThresholdsInput = z.infer<typeof updateRuleThresholdsSchema>;
