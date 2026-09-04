import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUserId } from "../lib/session.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { env } from "../env.js";
import { resolveEntitlement } from "../lib/entitlement.js";
import { isStripeConfigured, stripeClient } from "../integrations/stripe/client.js";
import { logger } from "../lib/logger.js";
import { getAiUsageThisMonthMicros } from "../lib/aiCost.js";

const checkoutRequestSchema = z.object({
  plan: z.enum(["monthly", "annual"]),
});

function priceForPlan(plan: "monthly" | "annual"): string {
  return plan === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ANNUAL;
}

export async function billingRoutes(app: FastifyInstance) {
  // Registered in UNENTITLED_ALLOWED_PATHS (lib/activeUser.ts) — every route here has to work
  // for a user with no active entitlement, since that's exactly who needs to reach them.

  app.post("/api/billing/checkout", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    if (!isStripeConfigured()) {
      reply.status(503).send({ error: { message: "Billing is not configured.", code: "STRIPE_NOT_CONFIGURED" } });
      return;
    }

    const body = checkoutRequestSchema.parse(request.body);
    const priceId = priceForPlan(body.plan);
    if (!priceId) {
      reply.status(503).send({ error: { message: "Billing is not configured.", code: "STRIPE_NOT_CONFIGURED" } });
      return;
    }

    const [user] = await db
      .select({
        email: users.email,
        stripeCustomerId: users.stripeCustomerId,
        role: users.role,
        entitlementSource: users.entitlementSource,
        entitlementStatus: users.entitlementStatus,
        entitlementExpiresAt: users.entitlementExpiresAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    // Stripe will happily create a second subscription on the same customer, which means two
    // charges and two sets of webhooks racing over one entitlement row. Switching between
    // monthly and annual is the Customer Portal's job (POST /api/billing/portal), not a second
    // Checkout. Only a live *Stripe* entitlement blocks this — a comped or admin account can
    // still subscribe normally, since neither has a subscription to conflict with.
    const current = resolveEntitlement(user);
    if (current.active && current.source === "stripe") {
      reply.status(409).send({
        error: {
          message: "You already have an active subscription — use Manage billing to change your plan.",
          code: "ALREADY_SUBSCRIBED",
        },
      });
      return;
    }

    const stripe = stripeClient();

    // Create (and persist) the customer before creating the Checkout session — the webhook
    // handler resolves the user by stripeCustomerId, so this column has to be on the row
    // before Stripe could possibly fire an event for it.
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
      customerId = customer.id;
      await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: env.STRIPE_TRIAL_DAYS,
        // Belt-and-suspenders alongside the customer-id lookup in
        // integrations/stripe/entitlement.ts, in case that link is ever missing.
        metadata: { userId },
      },
      // Collects a card up front even during the trial — see STRIPE_TRIAL_DAYS' comment in
      // env.ts: the trial is for seeing your own data in the app, not for skipping card entry.
      payment_method_collection: "always",
      success_url: `${env.WEB_ORIGIN}/settings?checkout=success`,
      cancel_url: `${env.WEB_ORIGIN}/subscribe?checkout=canceled`,
    });

    if (!session.url) {
      logger.error({ userId, sessionId: session.id }, "stripe checkout session created with no url");
      reply.status(502).send({ error: { message: "Failed to start checkout", code: "CHECKOUT_FAILED" } });
      return;
    }

    return { url: session.url };
  });

  app.post("/api/billing/portal", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    if (!isStripeConfigured()) {
      reply.status(503).send({ error: { message: "Billing is not configured.", code: "STRIPE_NOT_CONFIGURED" } });
      return;
    }

    const [user] = await db.select({ stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, userId));
    if (!user?.stripeCustomerId) {
      reply.status(400).send({
        error: { message: "No billing account yet — subscribe first.", code: "NO_STRIPE_CUSTOMER" },
      });
      return;
    }

    const session = await stripeClient().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${env.WEB_ORIGIN}/settings`,
    });

    return { url: session.url };
  });

  app.get("/api/billing/status", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      reply.status(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    const aiUsageThisMonthMicros = await getAiUsageThisMonthMicros(userId);

    return {
      entitlement: resolveEntitlement(user),
      hasStripeCustomer: user.stripeCustomerId != null,
      stripeConfigured: isStripeConfigured(),
      aiUsageThisMonthMicros,
      aiMonthlyLimitMicros: env.aiMonthlyCostLimitMicros,
    };
  });
}
