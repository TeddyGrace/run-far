import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

import type { RuleOutput } from "./types.js";

/**
 * Both sources are stubbed so this suite can aim exact outputs at the seam — the rules engine's
 * own behavior is covered by evaluate.test.ts and the per-rule suites. What is under test here is
 * service.ts's grouping: that rendered and shadow outputs are arbitrated apart, persisted with
 * attribution, and swept without one source deleting another's rows.
 */
const ruleOutputs = vi.hoisted(() => ({ current: [] as RuleOutput[] }));
const modelOutputs = vi.hoisted(() => ({ current: [] as RuleOutput[] }));

vi.mock("./sources/rulesSource.js", () => ({
  rulesSource: { id: "rules", version: null, generate: async () => ruleOutputs.current },
}));
vi.mock("./sources/modelSource.js", () => ({
  modelSource: { id: "model", version: "v-test", generate: async () => modelOutputs.current },
}));

const { db } = await import("../db/client.js");
const { users, recommendations } = await import("../db/schema.js");
const { generateRecommendations } = await import("./service.js");
const { eq, and } = await import("drizzle-orm");

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function card(overrides: Partial<RuleOutput> & Pick<RuleOutput, "ruleId">): RuleOutput {
  return {
    severity: "yellow",
    summary: `${overrides.ruleId} summary`,
    reason: `${overrides.ruleId} reason.`,
    proposedChanges: [],
    ...overrides,
  };
}

const claimsRun = (ruleId: string) =>
  card({
    ruleId,
    proposedChanges: [{ plannedRunId: RUN_ID, field: "scheduledAt", from: "a", to: "b" }],
  });

let userId: string;

async function rows() {
  return db
    .select({
      ruleId: recommendations.ruleId,
      source: recommendations.source,
      modelVersion: recommendations.modelVersion,
      reason: recommendations.reason,
      rank: recommendations.rank,
      status: recommendations.status,
      appliedAt: recommendations.appliedAt,
    })
    .from(recommendations)
    .where(eq(recommendations.userId, userId))
    .orderBy(recommendations.source, recommendations.rank);
}

async function setModelRendered(rendered: boolean) {
  await db.update(users).set({ modelRenderedOverride: rendered }).where(eq(users.id, userId));
}

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `sources-test-${randomUUID()}@run-far.local`, passwordHash: "x" })
    .returning({ id: users.id });
  userId = user!.id;
  ruleOutputs.current = [];
  modelOutputs.current = [];
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("shadow isolation", () => {
  beforeEach(() => {
    ruleOutputs.current = [claimsRun("sleep-debt")];
    modelOutputs.current = [claimsRun("model-reschedule")];
  });

  it("does not let a shadow card claim a run or edit the rendered card's reason", async () => {
    await generateRecommendations(userId, { ingestion: true });

    const persisted = await rows();
    const rendered = persisted.filter((r) => r.source === "rules");
    const shadow = persisted.filter((r) => r.source === "model");

    // The contamination this guards against: pooled arbitration would have demoted the model
    // card into the rules card's reason, changing visible output for an engine that is off.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.reason).toBe("sleep-debt reason.");
    expect(rendered[0]?.reason).not.toContain("Also noted");

    // Both still claim the same run — which is exactly why they must be arbitrated apart.
    expect(shadow).toHaveLength(1);
    expect(shadow[0]?.ruleId).toBe("model-reschedule");
    expect(shadow[0]?.modelVersion).toBe("v-test");
  });

  it("produces rendered rows identical to a run where the model never fired at all", async () => {
    await generateRecommendations(userId, { ingestion: true });
    const withShadow = (await rows()).filter((r) => r.source === "rules");

    await db.delete(recommendations).where(eq(recommendations.userId, userId));
    modelOutputs.current = [];
    await generateRecommendations(userId, { ingestion: true });

    expect(withShadow).toEqual((await rows()).filter((r) => r.source === "rules"));
  });

  it("keeps shadow rows through a dashboard read that only regenerates rules", async () => {
    await generateRecommendations(userId, { ingestion: true });
    expect((await rows()).filter((r) => r.source === "model")).toHaveLength(1);

    // The sharp edge: an unscoped retraction sweep would delete the model's row here, wiping the
    // scoring record on every single page load.
    await generateRecommendations(userId);
    await generateRecommendations(userId);

    expect((await rows()).filter((r) => r.source === "model")).toHaveLength(1);
  });

  it("is not addressable — a shadow row never reaches the rendered list", async () => {
    await generateRecommendations(userId, { ingestion: true });
    const { renderedSourceIdsFor } = await import("../lib/modelRendering.js");

    expect(await renderedSourceIdsFor(userId)).toEqual(["rules"]);
  });
});

describe("model switched on", () => {
  it("arbitrates the model against rules instead of beside them", async () => {
    await setModelRendered(true);
    ruleOutputs.current = [claimsRun("sleep-debt")];
    modelOutputs.current = [claimsRun("model-reschedule")];

    await generateRecommendations(userId);

    // Now they compete: one card per run, the loser folded into the winner's reason.
    const persisted = await rows();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.source).toBe("rules");
    expect(persisted[0]?.reason).toContain("Also noted: model-reschedule summary");
  });

  it("gives two sources emitting the same ruleId a row each, idempotently", async () => {
    await setModelRendered(true);
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    modelOutputs.current = [card({ ruleId: "sleep-debt", summary: "model's take" })];

    await generateRecommendations(userId);
    expect(await rows()).toHaveLength(2);

    // The pending unique index is (user, source, ruleId) — without `source` the second upsert
    // would clobber the first rather than sitting alongside it.
    await generateRecommendations(userId);
    const persisted = await rows();
    expect(persisted).toHaveLength(2);
    expect(persisted.map((r) => r.source)).toEqual(["model", "rules"]);
  });

  it("retracts a source's own stale rows without touching the other's", async () => {
    await setModelRendered(true);
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    modelOutputs.current = [card({ ruleId: "model-note" })];
    await generateRecommendations(userId);
    expect(await rows()).toHaveLength(2);

    modelOutputs.current = [];
    await generateRecommendations(userId);

    // Retraction expires rather than deletes, so the model's row is still here — it is just no
    // longer pending. What must not happen is the rules row being swept along with it.
    const persisted = await rows();
    expect(persisted).toHaveLength(2);

    const pending = persisted.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.source).toBe("rules");

    const retracted = persisted.filter((r) => r.source === "model");
    expect(retracted).toHaveLength(1);
    expect(retracted[0]?.status).toBe("expired");
    expect(retracted[0]?.appliedAt).toBeInstanceOf(Date);
  });
});

describe("suppression", () => {
  it("does not let a dismissal on one source silence the other", async () => {
    await setModelRendered(true);
    ruleOutputs.current = [card({ ruleId: "shared" })];
    modelOutputs.current = [card({ ruleId: "shared" })];
    await generateRecommendations(userId);

    // Same ruleId, same summary/reason — so the two rows share a fingerprint. Resolving the
    // rules one must not suppress the model one: they are being scored independently.
    await db
      .update(recommendations)
      .set({ status: "dismissed", appliedAt: new Date() })
      .where(and(eq(recommendations.userId, userId), eq(recommendations.source, "rules")));

    await generateRecommendations(userId);

    const pending = (await rows()).filter((r) => r.source === "model");
    expect(pending).toHaveLength(1);
  });
});
