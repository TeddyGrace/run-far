import type Stripe from "stripe";
import { eq, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";

type EntitlementStatus = "trialing" | "active" | "past_due" | "canceled";

/** Stripe has more statuses than we distinguish in entitlementStatus — everything that isn't
 * clearly trialing/active/past_due collapses to "canceled" (no access), which is the safe
 * direction to be wrong in for a status we've never seen before. */
function mapStatus(status: Stripe.Subscription.Status): EntitlementStatus {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due") return "past_due";
  return "canceled";
}

/**
 * The only writer of Stripe-derived entitlement state — every subscription-related webhook
 * event funnels through this. Resolves the user by stripeCustomerId first (set synchronously
 * in routes/billing.ts before the Checkout redirect, so it's already on the row by the time
 * any webhook for that customer can arrive) and falls back to the userId Checkout stamped
 * into the subscription's metadata, in case the customer-id link is ever missing.
 *
 * Guards against out-of-order delivery: a webhook older than the last one actually applied
 * (users.entitlementSyncedAt) is a no-op rather than overwriting newer state with stale data.
 */
export async function applyStripeSubscription(
  subscription: Stripe.Subscription,
  eventCreated: Date,
): Promise<void> {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const metadataUserId = subscription.metadata.userId;

  const [user] = await db
    .select({
      id: users.id,
      entitlementSource: users.entitlementSource,
      entitlementSyncedAt: users.entitlementSyncedAt,
    })
    .from(users)
    .where(
      metadataUserId
        ? or(eq(users.stripeCustomerId, customerId), eq(users.id, metadataUserId))
        : eq(users.stripeCustomerId, customerId),
    );

  if (!user) {
    logger.error({ customerId, subscriptionId: subscription.id }, "stripe webhook: no user for customer");
    return;
  }

  if (user.entitlementSyncedAt && eventCreated <= user.entitlementSyncedAt) {
    logger.info({ userId: user.id, subscriptionId: subscription.id }, "stripe webhook: stale event, skipping");
    return;
  }

  const item = subscription.items.data[0];
  const expiresAt = item ? new Date(item.current_period_end * 1000) : null;
  // A comp is admin-granted and must never be silently overwritten by a Stripe event (e.g. a
  // comped athlete who also runs a Checkout out of curiosity) — the subscription bookkeeping
  // (customer/sub ids, sync timestamp) is still recorded so it's accurate the moment the comp
  // is later cleared (see routes/admin.ts comp endpoints), but entitlementSource/Status/
  // ExpiresAt stay untouched while source is "comp".
  const isComped = user.entitlementSource === "comp";

  await db
    .update(users)
    .set({
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      entitlementSyncedAt: eventCreated,
      ...(isComped
        ? {}
        : {
            entitlementSource: "stripe" as const,
            entitlementStatus: mapStatus(subscription.status),
            entitlementExpiresAt: expiresAt,
          }),
    })
    .where(eq(users.id, user.id));
}
