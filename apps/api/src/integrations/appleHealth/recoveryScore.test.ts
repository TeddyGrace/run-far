import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

const { deriveRecoveryScore, deriveSleepNeedMin, sampleStats, MIN_BASELINE_DAYS } = await import(
  "./recoveryScore.js"
);

const { DEFAULT_RULE_THRESHOLDS } = await import("../../recommendations/config.js");

/**
 * The derived recovery score is the one number in the app that run-far invents rather than
 * reports — Apple Health publishes no recovery score, so for Apple athletes this is what the
 * red/yellow thresholds are compared against. These tests pin the properties that make it safe
 * to act on: it is relative to the athlete's own baseline, it is silent when it doesn't know
 * enough, and each component moves it in the physiologically correct direction.
 */

const BASELINES = {
  hrv: { mean: 60, sd: 8, n: 30 },
  restingHr: { mean: 50, sd: 3, n: 30 },
  respiratoryRate: { mean: 14, sd: 0.6, n: 30 },
  skinTempC: { mean: 33, sd: 0.3, n: 30 },
  days: 30,
};

const AVERAGE_DAY = {
  hrvMs: 60,
  restingHr: 50,
  asleepMin: 480,
  sleepNeedMin: 480,
  respiratoryRate: 14,
  skinTempC: 33,
};

describe("deriveRecoveryScore calibration", () => {
  it("scores an entirely average day well clear of the yellow band", () => {
    // The calibration documented in recoveryScore.ts: a day where every reading sits at baseline
    // and sleep need is met is an ordinary day, not a cautionary one. It lands in the high 80s
    // because the curve's resolution is deliberately concentrated on the downside — the half the
    // engine acts on. Centring an average day near 50 instead would put every ordinary day in
    // yellow and have the engine proposing to soften sessions when nothing is wrong.
    const { score, scoreState } = deriveRecoveryScore(AVERAGE_DAY, BASELINES);
    expect(scoreState).toBe("SCORED");
    expect(score).toBeGreaterThan(DEFAULT_RULE_THRESHOLDS.recoveryYellowMax);
    expect(score).toBeGreaterThanOrEqual(85);
    expect(score).toBeLessThan(95);
  });

  it("is relative to the athlete, not to an absolute HRV", () => {
    // Two athletes with very different absolute SDNN, each sitting exactly at their own
    // baseline, must score the same. This is the property that makes a self-derived score
    // defensible at all — it has no opinion about what a good HRV is.
    const lowHrv = deriveRecoveryScore(
      { ...AVERAGE_DAY, hrvMs: 28 },
      { ...BASELINES, hrv: { mean: 28, sd: 4, n: 30 } },
    );
    const highHrv = deriveRecoveryScore(
      { ...AVERAGE_DAY, hrvMs: 95 },
      { ...BASELINES, hrv: { mean: 95, sd: 12, n: 30 } },
    );
    expect(lowHrv.score).toBe(highHrv.score);
  });

  it("puts a badly suppressed day in the red zone the rules act on", () => {
    // 2 SDs down on HRV and up on resting HR, an hour short on sleep: the shape of a day the
    // engine should be proposing to downgrade a hard session on.
    const { score } = deriveRecoveryScore(
      { ...AVERAGE_DAY, hrvMs: 44, restingHr: 56, asleepMin: 420 },
      BASELINES,
    );
    expect(score).toBeLessThanOrEqual(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);
  });

  it("puts a mildly off day in the yellow band rather than red", () => {
    // HRV 1.5 SD down, resting HR 1 SD up, half an hour short of sleep: a composite around one
    // SD down, which by construction sits between the yellow and red anchors.
    const { score } = deriveRecoveryScore(
      { ...AVERAGE_DAY, hrvMs: 48, restingHr: 53, asleepMin: 450 },
      BASELINES,
    );
    expect(score).toBeGreaterThan(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);
    expect(score).toBeLessThanOrEqual(DEFAULT_RULE_THRESHOLDS.recoveryYellowMax);
  });

  it("puts the red and yellow anchors exactly on the shipped thresholds", () => {
    // The curve is solved through these two points, so this is the calibration's own statement
    // of intent: a composite 0.75 SD down is the yellow boundary, 1.5 SD down is the red one.
    // If the anchors or the defaults move, this is what says so out loud.
    const atYellow = deriveRecoveryScore(
      { ...AVERAGE_DAY, hrvMs: BASELINES.hrv.mean - 0.75 * BASELINES.hrv.sd },
      BASELINES,
    );
    const atRed = deriveRecoveryScore(
      { ...AVERAGE_DAY, hrvMs: BASELINES.hrv.mean - 1.5 * BASELINES.hrv.sd },
      BASELINES,
    );
    // A single component 0.75 SD down is only 0.4 * 0.75 of the composite — a composite that
    // deep needs every input to move together, which is the point of the anchor comment.
    expect(atYellow.score).toBeGreaterThan(DEFAULT_RULE_THRESHOLDS.recoveryYellowMax);
    expect(atRed.score).toBeGreaterThan(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);

    // Driven by the composite directly: every component exactly at the anchor depth.
    const allDown = (sds: number) =>
      deriveRecoveryScore(
        {
          hrvMs: BASELINES.hrv.mean - sds * BASELINES.hrv.sd,
          restingHr: BASELINES.restingHr.mean + sds * BASELINES.restingHr.sd,
          asleepMin: 480 * (1 - sds * 0.12),
          sleepNeedMin: 480,
          respiratoryRate: BASELINES.respiratoryRate.mean + sds * BASELINES.respiratoryRate.sd,
          skinTempC: BASELINES.skinTempC.mean + sds * BASELINES.skinTempC.sd,
        },
        BASELINES,
      ).score;
    expect(allDown(0.75)).toBe(DEFAULT_RULE_THRESHOLDS.recoveryYellowMax);
    expect(allDown(1.5)).toBe(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);
  });

  it("stays inside 0-100 under absurd readings", () => {
    const terrible = deriveRecoveryScore(
      { hrvMs: 1, restingHr: 200, asleepMin: 0, sleepNeedMin: 480, respiratoryRate: 40, skinTempC: 40 },
      BASELINES,
    );
    const impossible = deriveRecoveryScore(
      { hrvMs: 400, restingHr: 20, asleepMin: 1200, sleepNeedMin: 480, respiratoryRate: 8, skinTempC: 30 },
      BASELINES,
    );
    expect(terrible.score).toBeGreaterThanOrEqual(0);
    expect(impossible.score).toBeLessThanOrEqual(100);
  });
});

describe("deriveRecoveryScore component directions", () => {
  it("reads higher HRV as better recovered", () => {
    const up = deriveRecoveryScore({ ...AVERAGE_DAY, hrvMs: 72 }, BASELINES).score!;
    const down = deriveRecoveryScore({ ...AVERAGE_DAY, hrvMs: 48 }, BASELINES).score!;
    expect(up).toBeGreaterThan(down);
  });

  it("reads a *lower* resting heart rate as better recovered", () => {
    // The inversion that would be silently backwards if the sign were wrong — and backwards
    // exactly on the days the engine is supposed to notice.
    const lower = deriveRecoveryScore({ ...AVERAGE_DAY, restingHr: 45 }, BASELINES).score!;
    const higher = deriveRecoveryScore({ ...AVERAGE_DAY, restingHr: 57 }, BASELINES).score!;
    expect(lower).toBeGreaterThan(higher);
  });

  it("reads an elevated respiratory rate as worse recovered", () => {
    const elevated = deriveRecoveryScore({ ...AVERAGE_DAY, respiratoryRate: 16 }, BASELINES).score!;
    expect(elevated).toBeLessThan(deriveRecoveryScore(AVERAGE_DAY, BASELINES).score!);
  });

  it("penalizes an elevated wrist temperature but does not reward a cool night", () => {
    // Elevated distal temperature is the illness signal. A night measuring cooler than baseline
    // is not evidence of better recovery, so it must not be able to lift the score.
    const average = deriveRecoveryScore(AVERAGE_DAY, BASELINES).score!;
    const feverish = deriveRecoveryScore({ ...AVERAGE_DAY, skinTempC: 33.9 }, BASELINES).score!;
    const cool = deriveRecoveryScore({ ...AVERAGE_DAY, skinTempC: 32.1 }, BASELINES).score!;
    expect(feverish).toBeLessThan(average);
    expect(cool).toBe(average);
  });

  it("penalizes sleeping short of need", () => {
    const short = deriveRecoveryScore({ ...AVERAGE_DAY, asleepMin: 360 }, BASELINES).score!;
    expect(short).toBeLessThan(deriveRecoveryScore(AVERAGE_DAY, BASELINES).score!);
  });
});

describe("deriveRecoveryScore data sufficiency", () => {
  it("withholds a score until there is enough baseline history", () => {
    // A score built on a 3-day SD swings on ordinary variation — which for a new athlete means
    // a red-recovery card, and a real recommendation to abandon a real session, out of noise.
    // The rules read a null score as "no opinion" and stay silent, which is correct here.
    const { score, scoreState } = deriveRecoveryScore(AVERAGE_DAY, { ...BASELINES, days: 3 });
    expect(score).toBeNull();
    expect(scoreState).toBe("PENDING_SCORE");
  });

  it("scores as soon as the baseline requirement is met", () => {
    const { scoreState } = deriveRecoveryScore(AVERAGE_DAY, {
      ...BASELINES,
      days: MIN_BASELINE_DAYS,
    });
    expect(scoreState).toBe("SCORED");
  });

  it("reports a night with no readings at all as unscorable, not pending", () => {
    // The watch wasn't worn. No amount of waiting will score this night, and calling it pending
    // would have the app telling the athlete to keep collecting baseline for a night that can
    // never be scored.
    const { score, scoreState } = deriveRecoveryScore(
      { hrvMs: null, restingHr: null, asleepMin: null, sleepNeedMin: null, respiratoryRate: null, skinTempC: null },
      BASELINES,
    );
    expect(score).toBeNull();
    expect(scoreState).toBe("UNSCORABLE");
  });

  it("refuses to build a recovery score out of sleep duration alone", () => {
    // Sleep is the one component scored against need rather than a measured baseline, so it is
    // meaningful with no history. That makes it possible to have plenty of "days" and still no
    // baseline-scored input — and a score from sleep duration alone is a sleep score wearing a
    // recovery score's name.
    const { score, scoreState } = deriveRecoveryScore(
      { hrvMs: null, restingHr: null, asleepMin: 300, sleepNeedMin: 480, respiratoryRate: null, skinTempC: null },
      { hrv: null, restingHr: null, respiratoryRate: null, skinTempC: null, days: 30 },
    );
    expect(score).toBeNull();
    expect(scoreState).toBe("PENDING_SCORE");
  });

  it("scores from the components that are present, unpenalized for the ones that aren't", () => {
    // A watch-only sleeper with no wrist-temperature or SpO2 data should get a score built from
    // what they have — the weights of present components are renormalized, so a missing input
    // is not a zero.
    const partial = deriveRecoveryScore(
      { ...AVERAGE_DAY, skinTempC: null, respiratoryRate: null },
      { ...BASELINES, skinTempC: null, respiratoryRate: null },
    );
    const full = deriveRecoveryScore(AVERAGE_DAY, BASELINES);
    expect(partial.scoreState).toBe("SCORED");
    expect(partial.score).toBe(full.score);
  });

  it("records the working behind a score for audit", () => {
    const { components } = deriveRecoveryScore(AVERAGE_DAY, BASELINES);
    expect(components?.baselineDays).toBe(30);
    expect(components?.components.map((c) => c.key).sort()).toEqual([
      "hrv",
      "respiratoryRate",
      "restingHr",
      "skinTemp",
      "sleep",
    ]);
  });
});

describe("sampleStats", () => {
  it("returns null below two points, where an SD means nothing", () => {
    expect(sampleStats([])).toBeNull();
    expect(sampleStats([50])).toBeNull();
  });

  it("returns null for a degenerate zero SD rather than a divide-by-zero downstream", () => {
    expect(sampleStats([50, 50, 50])).toBeNull();
  });

  it("computes the sample mean and SD", () => {
    const stats = sampleStats([10, 12, 14])!;
    expect(stats.mean).toBe(12);
    expect(stats.sd).toBeCloseTo(2, 6);
    expect(stats.n).toBe(3);
  });
});

describe("deriveSleepNeedMin", () => {
  it("falls back to a 7h floor without enough history", () => {
    expect(deriveSleepNeedMin([])).toBe(420);
    expect(deriveSleepNeedMin([300, 320])).toBe(420);
  });

  it("uses the athlete's own good nights, not their average", () => {
    // The mean of an under-slept athlete's history is an under-slept night; measuring need
    // against it would make the sleep component structurally unable to report a shortfall.
    const need = deriveSleepNeedMin([360, 370, 380, 390, 480, 490, 500, 510]);
    expect(need).toBeGreaterThan(420);
    expect(need).toBeGreaterThanOrEqual(490);
  });

  it("never drops below the floor for a chronically short sleeper", () => {
    expect(deriveSleepNeedMin([300, 310, 320, 330, 340, 350])).toBe(420);
  });
});
