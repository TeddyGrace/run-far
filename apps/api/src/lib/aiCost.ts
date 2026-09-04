import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { aiUsage, users } from "../db/schema.js";
import { env } from "../env.js";
import { rateLimitKey } from "./session.js";

type UsageTotals = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

// USD per million tokens, current as of this writing — see https://www.anthropic.com/pricing.
// A model not listed here falls back to the Sonnet row: close enough to avoid undercounting a
// pricier model that shipped after this table did, which is the safer direction to be wrong in.
const PRICING_PER_MILLION_USD: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const FALLBACK_PRICING = PRICING_PER_MILLION_USD["claude-sonnet-4-5"]!;

/** Integer micro-dollars (1,000,000 = $1) so stored cost never depends on float rounding. */
export function estimateCostMicros(model: string, usage: UsageTotals): number {
  const pricing = PRICING_PER_MILLION_USD[model] ?? FALLBACK_PRICING;
  const dollars =
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheWriteTokens * pricing.cacheWrite +
      usage.cacheReadTokens * pricing.cacheRead) /
    1_000_000;
  return Math.round(dollars * 1_000_000);
}

/**
 * Accumulates token usage across every Anthropic call in one tool-use loop (assistantChat.ts /
 * planChat.ts each make several round trips per user-facing turn) and writes exactly one
 * ai_usage row for the whole turn on `flush`. Both the streaming and non-streaming path in each
 * file need to call `add` after every `client.messages.create` / `stream.finalMessage()`.
 */
export class AiUsageAccumulator {
  private totals: UsageTotals = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

  add(usage: Anthropic.Usage): void {
    this.totals.inputTokens += usage.input_tokens;
    this.totals.outputTokens += usage.output_tokens;
    this.totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  }

  async flush(params: { userId: string; surface: "plan_builder" | "assistant"; model: string }): Promise<void> {
    // A turn that never called the API (shouldn't happen, but cheap to guard) writes nothing.
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = this.totals;
    if (inputTokens === 0 && outputTokens === 0) return;

    await db.insert(aiUsage).values({
      userId: params.userId,
      surface: params.surface,
      model: params.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estimatedCostMicros: estimateCostMicros(params.model, this.totals),
    });
  }
}

export class AiQuotaExceededError extends Error {
  constructor(readonly limitMicros: number, readonly spentMicros: number) {
    super("AI monthly usage quota exceeded");
  }
}

/** Sum of estimatedCostMicros for `userId` since the start of the current UTC calendar month —
 * the same window assertWithinAiQuota checks against. Shared so routes/billing.ts can surface
 * the same number the quota is enforced from, rather than a second, possibly-drifted query. */
export async function getAiUsageThisMonthMicros(userId: string): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ spentMicros: sql<number>`coalesce(sum(${aiUsage.estimatedCostMicros}), 0)::integer` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, startOfMonth)));

  return row?.spentMicros ?? 0;
}

/**
 * Throws if the user's calendar-month AI spend is already at or over the configured limit.
 * Checked once at the start of a turn — not mid-loop — so a single conversation can overshoot
 * the cap by at most one turn's worth of usage, in exchange for not having to abort a
 * half-finished tool-use loop mid-stream.
 *
 * Admins and comped accounts are exempt: the cap exists to bound what an anonymous paying
 * (or trialing) signup can cost, and the operator shouldn't be able to lock themselves —
 * or someone they deliberately gave free access — out of their own product. Usage is still
 * recorded for them, so the backoffice's per-user cost column stays accurate.
 */
export async function assertWithinAiQuota(userId: string): Promise<void> {
  const [user] = await db
    .select({ role: users.role, entitlementSource: users.entitlementSource })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return; // The route's own auth check owns this case.
  if (user.role === "admin" || user.entitlementSource === "comp") return;

  const spentMicros = await getAiUsageThisMonthMicros(userId);
  if (spentMicros >= env.aiMonthlyCostLimitMicros) {
    throw new AiQuotaExceededError(env.aiMonthlyCostLimitMicros, spentMicros);
  }
}

/** rateLimitKey returns a user id when there's a valid session and falls back to request.ip
 * otherwise — this tells the two apart so the admin exemption below can only ever be granted
 * to an actual authenticated user id, never to something shaped like an IP. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared @fastify/rate-limit config for the four AI routes (routes/plans.ts and
 * routes/assistant.ts), which are far more expensive per call than the 200/min global limit
 * in server.ts assumes. Keyed per user rather than per IP so one household or office doesn't
 * share a budget.
 *
 * Admins are exempt for the same reason they're exempt from the monthly quota above: this is
 * a bound on what an anonymous signup can cost, and the operator testing their own product
 * shouldn't be throttled by it.
 */
export const aiRouteRateLimit = {
  max: 20,
  timeWindow: "1 hour",
  keyGenerator: rateLimitKey,
  allowList: async (_request: unknown, key: string): Promise<boolean> => {
    if (!UUID_RE.test(key)) return false;
    const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, key));
    return user?.role === "admin";
  },
};
