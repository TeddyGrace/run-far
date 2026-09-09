import { describe, it, expect, vi } from "vitest";
import { gather, planSources, rulesSource, modelSource, ALL_SOURCE_IDS } from "./index.js";
import type { RecommendationSource } from "./types.js";
import type { RuleContext, RuleOutput } from "../types.js";
import { evaluate } from "../evaluate.js";
import { RECOMMENDATION_CONFIG } from "../config.js";

/** A context nothing fires on — enough to exercise the plumbing without fixture snapshots,
 * which the rule-level suites already cover. */
const emptyCtx = {
  snapshot: {
    date: "2026-09-08",
    recoveryScore: null,
    hrvRmssdMs: null,
    hrvBaselineMs: null,
    hrvBaselineSd: null,
    restingHr: null,
    restingHrBaseline: null,
    sleepDebtMinToday: null,
    cycleStrainAvg7d: null,
    cycleLoadSum7d: null,
    cyclesCounted7d: 0,
    acwr: null,
    runDistanceMThisWeek: null,
    runDistanceMPerWeekThisMonth: null,
    hrvSuppressedConsecutiveDays: 0,
  },
  upcoming: [],
  busyPeriods: [],
  weatherForecast: [],
  timeZone: "America/New_York",
  now: new Date("2026-09-08T12:00:00Z"),
} as unknown as RuleContext;

function fakeSource(id: string, generate: () => Promise<RuleOutput[]>): RecommendationSource {
  return { id, version: null, generate };
}

describe("rulesSource", () => {
  it("produces exactly what evaluate() does", async () => {
    expect(await rulesSource.generate(emptyCtx)).toEqual(evaluate(emptyCtx));
  });

  it("is registered first, so it wins cross-source ties", () => {
    expect(ALL_SOURCE_IDS[0]).toBe("rules");
  });
});

describe("modelSource", () => {
  it("is a stub — enabling it changes nothing", async () => {
    expect(await modelSource.generate(emptyCtx)).toEqual([]);
  });
});

describe("planSources", () => {
  it("runs rules only on a plain dashboard read", () => {
    const plan = planSources({ modelRendered: false, ingestion: false });
    expect(plan.rendered.map((s) => s.id)).toEqual(["rules"]);
    expect(plan.shadow).toEqual([]);
  });

  it("shadows the model on ingestion events even while it is switched off", () => {
    const plan = planSources({ modelRendered: false, ingestion: true });
    expect(plan.rendered.map((s) => s.id)).toEqual(["rules"]);
    expect(plan.shadow.map((s) => s.id)).toEqual(["model"]);
  });

  it("renders the model on every regeneration once switched on, never as shadow", () => {
    for (const ingestion of [false, true]) {
      const plan = planSources({ modelRendered: true, ingestion });
      expect(plan.rendered.map((s) => s.id)).toEqual(["rules", "model"]);
      expect(plan.shadow).toEqual([]);
    }
  });
});

describe("gather", () => {
  it("tags every output with its producer", async () => {
    const output = {
      ruleId: "m1",
      severity: "info",
      summary: "s",
      reason: "r",
      proposedChanges: [],
    } as RuleOutput;
    const source = fakeSource("model", async () => [output]);

    expect(await gather(source, emptyCtx, "user-1")).toEqual([{ source, output }]);
  });

  it("fails open when a non-rules source throws", async () => {
    const source = fakeSource("model", async () => {
      throw new Error("scoring service is down");
    });

    expect(await gather(source, emptyCtx, "user-1")).toEqual([]);
  });

  it("fails open when a non-rules source hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const source = fakeSource("model", () => new Promise<RuleOutput[]>(() => {}));
      const pending = gather(source, emptyCtx, "user-1");
      await vi.advanceTimersByTimeAsync(RECOMMENDATION_CONFIG.sources.timeoutMs + 1);
      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the rules source throw — a broken engine must not read as 'no recommendations'", async () => {
    const source = fakeSource("rules", async () => {
      throw new Error("bug in a rule");
    });

    await expect(gather(source, emptyCtx, "user-1")).rejects.toThrow("bug in a rule");
  });
});
