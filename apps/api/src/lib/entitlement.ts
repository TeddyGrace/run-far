import type { users } from "../db/schema.js";

type EntitlementSource = "comp" | "stripe" | "apple" | null;
type EntitlementStatus = "trialing" | "active" | "past_due" | "canceled" | "none";

export type Entitlement = {
  active: boolean;
  source: EntitlementSource;
  status: EntitlementStatus;
  expiresAt: Date | null;
};

/** The columns resolveEntitlement needs — a subset so callers (activeUserGuard, /api/auth/me,
 * the admin users list) can select only these instead of the whole row. */
export type EntitlementInput = Pick<
  typeof users.$inferSelect,
  "role" | "entitlementSource" | "entitlementStatus" | "entitlementExpiresAt"
>;

/**
 * The single place that answers "does this user have access?" — activeUserGuard, /api/auth/me,
 * and the AI-quota bypass all call this instead of reading entitlement columns directly, so the
 * resolution order only has to be gotten right once.
 *
 * Order: admin (never locks the operator out of their own backoffice — same reasoning as
 * loadDestructibleUser in routes/admin.ts) > comp (unconditional, set only by an admin, never
 * touches Stripe) > an unexpired Stripe trial/active subscription > everything else inactive.
 *
 * A comp with no entitlementExpiresAt never expires; one with an expiry (e.g. a time-limited
 * promo) is checked against `now` like a Stripe subscription is.
 */
export function resolveEntitlement(user: EntitlementInput, now: Date = new Date()): Entitlement {
  if (user.role === "admin") {
    return { active: true, source: null, status: "active", expiresAt: null };
  }

  const notExpired = user.entitlementExpiresAt == null || user.entitlementExpiresAt > now;

  if (user.entitlementSource === "comp") {
    return {
      active: notExpired,
      source: "comp",
      status: notExpired ? "active" : user.entitlementStatus,
      expiresAt: user.entitlementExpiresAt,
    };
  }

  if (
    (user.entitlementSource === "stripe" || user.entitlementSource === "apple") &&
    (user.entitlementStatus === "trialing" || user.entitlementStatus === "active") &&
    notExpired
  ) {
    return {
      active: true,
      source: user.entitlementSource,
      status: user.entitlementStatus,
      expiresAt: user.entitlementExpiresAt,
    };
  }

  return {
    active: false,
    source: user.entitlementSource,
    status: user.entitlementStatus,
    expiresAt: user.entitlementExpiresAt,
  };
}
