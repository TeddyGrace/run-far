import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { computeRollingSleepDebt } = await import("./sleepDebt.js");

/**
 * `sleep_records.sleep_debt_min` is compared against a minutes threshold by the sleep-debt rule,
 * and its schema comment warns in capitals never to re-aggregate it — Whoop's figure is already
 * cumulative. Apple publishes nothing of the kind, so this derivation has to honour the same
 * contract: what it returns is already rolling, and summing it would double-count.
 */

const NEED = 480;

function nights(...asleep: Array<number | null>) {
  return asleep.map((asleepMin, i) => ({
    localDate: `2026-09-${String(i + 1).padStart(2, "0")}`,
    asleepMin,
    sleepNeedMin: NEED,
  }));
}

describe("computeRollingSleepDebt", () => {
  it("carries no debt for an athlete meeting their need", () => {
    const debt = computeRollingSleepDebt(nights(480, 480, 480, 490));
    expect([...debt.values()]).toEqual([0, 0, 0, 0]);
  });

  it("accrues a short night's shortfall", () => {
    const debt = computeRollingSleepDebt(nights(360));
    expect(debt.get("2026-09-01")).toBe(120);
  });

  it("compounds consecutive short nights", () => {
    // Two bad nights in a row is worse than one, and must read that way — a model that forgave
    // each night overnight would never cross the rule's threshold no matter how long it ran.
    const debt = computeRollingSleepDebt(nights(390, 390));
    expect(debt.get("2026-09-02")!).toBeGreaterThan(debt.get("2026-09-01")!);
  });

  it("decays an old shortfall instead of remembering it forever", () => {
    // Sleep debt is not a ledger. An athlete who sleeps well for a week is square, and a
    // straight sum over a fixed window would instead step off a cliff when the window slid
    // past the bad night.
    const debt = computeRollingSleepDebt(nights(300, 480, 480, 480, 480, 480, 480, 480));
    expect(debt.get("2026-09-01")).toBe(180);
    // Seven nights of exactly meeting need: no repayment (that needs a night *above* need),
    // pure decay. ~8% of the original survives, which is far below the rule's 90-minute
    // threshold — and a single long night would clear it outright.
    expect(debt.get("2026-09-08")!).toBeLessThan(0.15 * 180);
    expect(debt.get("2026-09-08")!).toBeGreaterThan(0);
  });

  it("lets a long night pay debt down", () => {
    const debt = computeRollingSleepDebt(nights(360, 600));
    expect(debt.get("2026-09-02")).toBe(0);
  });

  it("never banks credit for oversleeping", () => {
    // Allowing a negative debt would let a long weekend mask a genuinely bad Tuesday.
    const debt = computeRollingSleepDebt(nights(700, 700, 360));
    expect(debt.get("2026-09-02")).toBe(0);
    expect(debt.get("2026-09-03")).toBe(120);
  });

  it("ignores a shortfall inside the noise floor", () => {
    // Watch sleep-stage durations are estimates; an 8-minute miss is not a deficit, and letting
    // it accrue would have the figure jittering above zero on nights that were fine.
    const debt = computeRollingSleepDebt(nights(472, 472, 472));
    expect([...debt.values()]).toEqual([0, 0, 0]);
  });

  it("treats an unrecorded night as unknown, not as zero sleep", () => {
    // An unworn watch must not manufacture an 8-hour deficit — that would propose cancelling
    // the next day's session on the strength of a charging cable.
    const debt = computeRollingSleepDebt(nights(480, null, 480));
    expect(debt.get("2026-09-02")).toBe(0);
    expect(debt.get("2026-09-03")).toBe(0);
  });

  it("decays existing debt across an unrecorded night rather than freezing it", () => {
    const debt = computeRollingSleepDebt(nights(300, null));
    expect(debt.get("2026-09-02")!).toBeLessThan(debt.get("2026-09-01")!);
    expect(debt.get("2026-09-02")!).toBeGreaterThan(0);
  });

  it("crosses the shipped 90-minute threshold only after a real run of bad nights", () => {
    // The figure has to be on the same scale the rule's default expects, or it either never
    // fires or fires constantly.
    const oneOkNight = computeRollingSleepDebt(nights(450));
    const threeBadNights = computeRollingSleepDebt(nights(390, 380, 400));
    expect(oneOkNight.get("2026-09-01")!).toBeLessThan(90);
    expect(threeBadNights.get("2026-09-03")!).toBeGreaterThan(90);
  });
});
