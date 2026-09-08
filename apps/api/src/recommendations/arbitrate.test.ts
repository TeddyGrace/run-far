import { describe, it, expect } from "vitest";
import { arbitrate } from "./arbitrate.js";
import type { RuleOutput } from "./types.js";

function rule(overrides: Partial<RuleOutput> & Pick<RuleOutput, "ruleId">): RuleOutput {
  return {
    severity: "yellow",
    summary: `${overrides.ruleId} summary`,
    reason: `${overrides.ruleId} reason.`,
    proposedChanges: [],
    ...overrides,
  };
}

function change(plannedRunId: string, field = "scheduledAt") {
  return { plannedRunId, field, from: "a", to: "b" };
}

describe("arbitrate", () => {
  it("gives a contested run to the higher-ranked rule and folds the loser into its reason", () => {
    const result = arbitrate([
      rule({ ruleId: "sleep-debt", proposedChanges: [change("run-1")] }),
      rule({ ruleId: "calendar-conflict", proposedChanges: [change("run-1")] }),
    ]);

    expect(result.map((r) => r.ruleId)).toEqual(["sleep-debt"]);
    expect(result[0]?.reason).toContain("Also noted: calendar-conflict summary");
  });

  it("leaves rules targeting different runs alone", () => {
    const result = arbitrate([
      rule({ ruleId: "sleep-debt", proposedChanges: [change("run-1")] }),
      rule({ ruleId: "calendar-conflict", proposedChanges: [change("run-2")] }),
    ]);

    expect(result.map((r) => r.ruleId)).toEqual(["sleep-debt", "calendar-conflict"]);
  });

  it("keeps a rule's uncontested changes and drops only the claimed ones", () => {
    const result = arbitrate([
      rule({ ruleId: "sleep-debt", proposedChanges: [change("run-1")] }),
      rule({ ruleId: "calendar-conflict", proposedChanges: [change("run-1"), change("run-2")] }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[1]?.proposedChanges.map((c) => c.plannedRunId)).toEqual(["run-2"]);
  });

  it("passes advisory rules through — they never compete for a run", () => {
    const result = arbitrate([
      rule({ ruleId: "red-recovery-hard-session", severity: "red", proposedChanges: [change("run-1")] }),
      rule({ ruleId: "acwr-spike", severity: "info" }),
      rule({ ruleId: "weather-advisory", severity: "info" }),
    ]);

    expect(result.map((r) => r.ruleId)).toEqual([
      "red-recovery-hard-session",
      "acwr-spike",
      "weather-advisory",
    ]);
  });

  it("never leaves two surviving cards proposing changes to the same run", () => {
    const result = arbitrate([
      rule({ ruleId: "red-recovery-hard-session", proposedChanges: [change("run-1", "runType")] }),
      rule({ ruleId: "yellow-recovery-hard-session", proposedChanges: [change("run-1", "durationMin")] }),
      rule({ ruleId: "sleep-debt", proposedChanges: [change("run-1")] }),
      rule({ ruleId: "calendar-conflict", proposedChanges: [change("run-1")] }),
    ]);

    const claimed = result.flatMap((r) => r.proposedChanges.map((c) => c.plannedRunId));
    expect(claimed).toEqual([...new Set(claimed)]);
  });

  it("does not mutate its input", () => {
    const loser = rule({ ruleId: "calendar-conflict", proposedChanges: [change("run-1")] });
    const winner = rule({ ruleId: "sleep-debt", proposedChanges: [change("run-1")] });
    const originalReason = winner.reason;

    arbitrate([winner, loser]);

    expect(winner.reason).toBe(originalReason);
    expect(loser.proposedChanges).toHaveLength(1);
  });
});
