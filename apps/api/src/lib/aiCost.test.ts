import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users, aiUsage } = await import("../db/schema.js");
const { inArray, eq } = await import("drizzle-orm");
const { estimateCostMicros, AiUsageAccumulator, assertWithinAiQuota, AiQuotaExceededError } = await import(
  "./aiCost.js"
);
const { env } = await import("../env.js");

describe("estimateCostMicros", () => {
  it("prices a known model from input/output/cache tokens", () => {
    const micros = estimateCostMicros("claude-sonnet-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // $3 per million input tokens for claude-sonnet-4-5.
    expect(micros).toBe(3_000_000);
  });

  it("falls back to the sonnet row for an unrecognized model rather than pricing it as free", () => {
    const known = estimateCostMicros("claude-sonnet-4-5", {
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const unknown = estimateCostMicros("claude-some-future-model", {
      inputTokens: 500_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(unknown).toBe(known);
  });
});

describe("AiUsageAccumulator", () => {
  let createdIds: string[];

  beforeEach(async () => {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({ email: `usage-test-${stamp}@run-far.local`, emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
  });

  afterEach(async () => {
    await db.delete(aiUsage).where(inArray(aiUsage.userId, createdIds));
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  it("accumulates usage across multiple add() calls into one row on flush", async () => {
    const userId = createdIds[0]!;
    const accumulator = new AiUsageAccumulator();
    accumulator.add({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } as never);
    accumulator.add({
      input_tokens: 200,
      output_tokens: 25,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 5,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    } as never);

    await accumulator.flush({ userId, surface: "assistant", model: "claude-sonnet-4-5" });

    const rows = await db.select().from(aiUsage).where(eq(aiUsage.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: 300,
      outputTokens: 75,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      surface: "assistant",
      model: "claude-sonnet-4-5",
    });
  });

  it("writes nothing when no usage was ever added", async () => {
    const userId = createdIds[0]!;
    const accumulator = new AiUsageAccumulator();
    await accumulator.flush({ userId, surface: "assistant", model: "claude-sonnet-4-5" });

    const rows = await db.select().from(aiUsage).where(eq(aiUsage.userId, userId));
    expect(rows).toHaveLength(0);
  });
});

describe("assertWithinAiQuota", () => {
  let createdIds: string[];

  beforeEach(async () => {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({ email: `quota-test-${stamp}@run-far.local`, emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
  });

  afterEach(async () => {
    await db.delete(aiUsage).where(inArray(aiUsage.userId, createdIds));
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  it("does not throw for a user with no usage this month", async () => {
    await expect(assertWithinAiQuota(createdIds[0]!)).resolves.toBeUndefined();
  });

  it("throws once this month's spend reaches the configured limit", async () => {
    const userId = createdIds[0]!;
    await db.insert(aiUsage).values({
      userId,
      surface: "assistant",
      model: "claude-sonnet-4-5",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicros: env.aiMonthlyCostLimitMicros,
    });

    await expect(assertWithinAiQuota(userId)).rejects.toBeInstanceOf(AiQuotaExceededError);
  });
  // env.ts documents admins and comps as exempt: the cap bounds what an anonymous signup can
  // cost, and it must never lock the operator out of their own product, or lock out someone
  // they deliberately gave free access to.
  it("exempts admins and comped accounts even when they're over the limit", async () => {
    const overLimit = env.aiMonthlyCostLimitMicros + 1;

    for (const overrides of [
      { role: "admin" as const },
      { entitlementSource: "comp" as const, entitlementStatus: "active" as const },
    ]) {
      const [row] = await db
        .insert(users)
        .values({ email: `exempt-${randomUUID()}@run-far.local`, emailVerifiedAt: new Date(), ...overrides })
        .returning({ id: users.id });
      if (!row) throw new Error("failed to seed exempt user");
      createdIds.push(row.id);

      await db.insert(aiUsage).values({
        userId: row.id,
        surface: "assistant",
        model: "claude-sonnet-4-5",
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostMicros: overLimit,
      });

      await expect(assertWithinAiQuota(row.id)).resolves.toBeUndefined();
    }
  });
});
