import { describe, expect, it } from "vitest";
import { resolveEntitlement, type EntitlementInput } from "./entitlement.js";

const NOW = new Date("2026-06-01T00:00:00Z");

function user(overrides: Partial<EntitlementInput>): EntitlementInput {
  return {
    role: "user",
    entitlementSource: null,
    entitlementStatus: "none",
    entitlementExpiresAt: null,
    ...overrides,
  };
}

describe("resolveEntitlement", () => {
  it("is active for an admin regardless of entitlement columns", () => {
    const result = resolveEntitlement(
      user({ role: "admin", entitlementSource: null, entitlementStatus: "none" }),
      NOW,
    );
    expect(result.active).toBe(true);
  });

  it("is active for a comped user with no expiry", () => {
    const result = resolveEntitlement(
      user({ entitlementSource: "comp", entitlementStatus: "active" }),
      NOW,
    );
    expect(result).toMatchObject({ active: true, source: "comp" });
  });

  it("is active for a comp with a future expiry", () => {
    const result = resolveEntitlement(
      user({
        entitlementSource: "comp",
        entitlementStatus: "active",
        entitlementExpiresAt: new Date("2026-07-01T00:00:00Z"),
      }),
      NOW,
    );
    expect(result.active).toBe(true);
  });

  it("is inactive for a comp that has expired", () => {
    const result = resolveEntitlement(
      user({
        entitlementSource: "comp",
        entitlementStatus: "active",
        entitlementExpiresAt: new Date("2026-05-01T00:00:00Z"),
      }),
      NOW,
    );
    expect(result.active).toBe(false);
  });

  it("is active for a trialing Stripe subscription before expiry", () => {
    const result = resolveEntitlement(
      user({
        entitlementSource: "stripe",
        entitlementStatus: "trialing",
        entitlementExpiresAt: new Date("2026-06-15T00:00:00Z"),
      }),
      NOW,
    );
    expect(result).toMatchObject({ active: true, source: "stripe", status: "trialing" });
  });

  it("is active for an active Stripe subscription before expiry", () => {
    const result = resolveEntitlement(
      user({
        entitlementSource: "stripe",
        entitlementStatus: "active",
        entitlementExpiresAt: new Date("2026-06-15T00:00:00Z"),
      }),
      NOW,
    );
    expect(result.active).toBe(true);
  });

  it("is inactive once a Stripe subscription's period has expired", () => {
    const result = resolveEntitlement(
      user({
        entitlementSource: "stripe",
        entitlementStatus: "active",
        entitlementExpiresAt: new Date("2026-05-15T00:00:00Z"),
      }),
      NOW,
    );
    expect(result.active).toBe(false);
  });

  it("is inactive for past_due, canceled, or none Stripe status", () => {
    for (const status of ["past_due", "canceled", "none"] as const) {
      const result = resolveEntitlement(
        user({
          entitlementSource: "stripe",
          entitlementStatus: status,
          entitlementExpiresAt: new Date("2026-06-15T00:00:00Z"),
        }),
        NOW,
      );
      expect(result.active).toBe(false);
    }
  });

  it("is inactive for a brand-new user with no entitlement at all", () => {
    const result = resolveEntitlement(user({}), NOW);
    expect(result).toMatchObject({ active: false, source: null, status: "none" });
  });

  it("treats apple the same as stripe for status/expiry checks", () => {
    const result = resolveEntitlement(
      user({
        entitlementSource: "apple",
        entitlementStatus: "active",
        entitlementExpiresAt: new Date("2026-06-15T00:00:00Z"),
      }),
      NOW,
    );
    expect(result.active).toBe(true);
  });
});
