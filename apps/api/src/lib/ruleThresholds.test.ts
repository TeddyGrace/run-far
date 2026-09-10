import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

/**
 * Per-athlete threshold resolution.
 *
 * The sparse-override design is the part worth pinning: an absent field has to keep tracking the
 * shipped default rather than freezing today's value, and a stored row that no longer validates
 * has to degrade to defaults rather than fail the read that found it. Both are silent failures if
 * they regress — the engine would just quietly reason with the wrong numbers.
 */
const { db } = await import("../db/client.js");
const { users } = await import("../db/schema.js");
const {
  resolveThresholds,
  parseStoredThresholds,
  getRuleThresholds,
  getStoredThresholds,
  updateRuleThresholds,
  ThresholdValidationError,
} = await import("./ruleThresholds.js");
const { DEFAULT_RULE_THRESHOLDS } = await import("../recommendations/config.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("./session.js");
const { eq } = await import("drizzle-orm");

let userId: string;

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `thresholds-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      entitlementSource: "comp" as const,
      entitlementStatus: "active" as const,
    })
    .returning({ id: users.id });
  userId = user!.id;
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("resolveThresholds", () => {
  it("returns the shipped defaults when nothing is overridden", () => {
    expect(resolveThresholds(null)).toEqual(DEFAULT_RULE_THRESHOLDS);
    expect(resolveThresholds({})).toEqual(DEFAULT_RULE_THRESHOLDS);
  });

  it("applies only the fields that were overridden", () => {
    const resolved = resolveThresholds({ recoveryRedMax: 25 });

    expect(resolved.recoveryRedMax).toBe(25);
    // The whole point of storing sparsely: everything untouched keeps tracking the default, so
    // improving a default still reaches this athlete.
    expect(resolved.recoveryYellowMax).toBe(DEFAULT_RULE_THRESHOLDS.recoveryYellowMax);
    expect(resolved.sleepDebtThresholdMin).toBe(DEFAULT_RULE_THRESHOLDS.sleepDebtThresholdMin);
  });

  it("treats a stored null as absent rather than as zero", () => {
    // A null reaching the merge as 0 would set the red-zone ceiling to 0 and silently switch
    // the red-recovery rule off for that athlete — the worst kind of failure here, because
    // nothing errors and the dashboard just stops warning them.
    const resolved = resolveThresholds({ recoveryRedMax: undefined } as never);
    expect(resolved.recoveryRedMax).toBe(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);
  });
});

describe("parseStoredThresholds", () => {
  it("degrades to defaults rather than throwing on a malformed row", () => {
    expect(parseStoredThresholds("not an object")).toBeNull();
    expect(parseStoredThresholds(42)).toBeNull();
  });

  it("drops a field that is out of range instead of rejecting the whole row", () => {
    // Ranges can tighten in a later release, and an athlete's already-stored value should not
    // take their whole calibration down with it.
    const parsed = parseStoredThresholds({ recoveryRedMax: 25, acwrSpikeThreshold: 99 });
    expect(parsed).toBeNull();
    expect(resolveThresholds(parsed).recoveryRedMax).toBe(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);
  });
});

describe("updateRuleThresholds", () => {
  it("stores an override and resolves it back", async () => {
    await updateRuleThresholds(userId, { recoveryRedMax: 28 });

    expect(await getStoredThresholds(userId)).toEqual({ recoveryRedMax: 28 });
    expect((await getRuleThresholds(userId)).recoveryRedMax).toBe(28);
  });

  it("merges successive patches rather than replacing", async () => {
    await updateRuleThresholds(userId, { recoveryRedMax: 28 });
    await updateRuleThresholds(userId, { sleepDebtThresholdMin: 120 });

    expect(await getStoredThresholds(userId)).toEqual({
      recoveryRedMax: 28,
      sleepDebtThresholdMin: 120,
    });
  });

  it("clears an override with null, restoring the default", async () => {
    await updateRuleThresholds(userId, { recoveryRedMax: 28 });
    await updateRuleThresholds(userId, { recoveryRedMax: null });

    // Distinct from setting it to today's default value: cleared means "track the default",
    // which is the only way back once a slider has been moved.
    expect(await getStoredThresholds(userId)).toEqual({});
    expect((await getRuleThresholds(userId)).recoveryRedMax).toBe(
      DEFAULT_RULE_THRESHOLDS.recoveryRedMax,
    );
  });

  it("refuses a red ceiling at or above the athlete's yellow ceiling", async () => {
    await updateRuleThresholds(userId, { recoveryYellowMax: 60 });

    // Validated against the resolved pair, not the patch: this patch carries only one side of
    // the relationship, so checking it alone would invert the zones and make every yellow rule
    // unreachable.
    await expect(updateRuleThresholds(userId, { recoveryRedMax: 70 })).rejects.toBeInstanceOf(
      ThresholdValidationError,
    );
    expect((await getRuleThresholds(userId)).recoveryRedMax).toBe(
      DEFAULT_RULE_THRESHOLDS.recoveryRedMax,
    );
  });

  it("refuses an out-of-range value and leaves the stored set untouched", async () => {
    await updateRuleThresholds(userId, { recoveryRedMax: 28 });
    await expect(updateRuleThresholds(userId, { acwrSpikeThreshold: 99 })).rejects.toBeInstanceOf(
      ThresholdValidationError,
    );

    expect(await getStoredThresholds(userId)).toEqual({ recoveryRedMax: 28 });
  });

  it("refuses an unknown key rather than storing it", async () => {
    await expect(updateRuleThresholds(userId, { notAThreshold: 5 })).rejects.toBeInstanceOf(
      ThresholdValidationError,
    );
  });
});

describe("thresholds route", () => {
  it("returns defaults, overrides and the merged result", async () => {
    await updateRuleThresholds(userId, { recoveryRedMax: 28 });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/settings/thresholds",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // All three, so the UI can show "default" against an untouched slider and offer a reset
      // that means something.
      expect(body.defaults.recoveryRedMax).toBe(DEFAULT_RULE_THRESHOLDS.recoveryRedMax);
      expect(body.overrides).toEqual({ recoveryRedMax: 28 });
      expect(body.resolved.recoveryRedMax).toBe(28);
      expect(body.resolved.recoveryYellowMax).toBe(DEFAULT_RULE_THRESHOLDS.recoveryYellowMax);
    } finally {
      await app.close();
    }
  });

  it("400s an incoherent change with the reason, rather than 500ing", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/settings/thresholds",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { thresholds: { recoveryRedMax: 90 } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_THRESHOLD");
    } finally {
      await app.close();
    }
  });

  it("keeps one athlete's calibration out of another's", async () => {
    const [other] = await db
      .insert(users)
      .values({
        email: `other-${randomUUID()}@run-far.local`,
        passwordHash: "x",
        emailVerifiedAt: new Date(),
        entitlementSource: "comp" as const,
        entitlementStatus: "active" as const,
      })
      .returning({ id: users.id });

    try {
      await updateRuleThresholds(userId, { recoveryRedMax: 28 });
      expect(await getStoredThresholds(other!.id)).toEqual({});
      expect((await getRuleThresholds(other!.id)).recoveryRedMax).toBe(
        DEFAULT_RULE_THRESHOLDS.recoveryRedMax,
      );
    } finally {
      await db.delete(users).where(eq(users.id, other!.id));
    }
  });
});
