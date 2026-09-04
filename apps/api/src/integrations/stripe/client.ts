import Stripe from "stripe";
import { env } from "../../env.js";

export function isStripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

// Constructed lazily (not at import time) so a dev checkout with no Stripe keys set never
// throws on module load — only routes/webhooks that actually need it call this, and they all
// check isStripeConfigured() first.
export function stripeClient(): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY);
}
