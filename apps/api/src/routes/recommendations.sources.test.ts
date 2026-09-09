import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

import type { RuleOutput } from "../recommendations/types.js";

/** Stubbed so the route's own regeneration produces known cards — the GET handler regenerates
 * before it reads, so rows inserted behind its back would simply be retracted as no longer
 * firing. */
const ruleOutputs = vi.hoisted(() => ({ current: [] as RuleOutput[] }));
const modelOutputs = vi.hoisted(() => ({ current: [] as RuleOutput[] }));

vi.mock("../recommendations/sources/rulesSource.js", () => ({
  rulesSource: { id: "rules", version: null, generate: async () => ruleOutputs.current },
}));
vi.mock("../recommendations/sources/modelSource.js", () => ({
  modelSource: { id: "model", version: "v-test", generate: async () => modelOutputs.current },
}));

const { db } = await import("../db/client.js");
const { users, recommendations } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { generateRecommendations } = await import("../recommendations/service.js");
const { and, eq } = await import("drizzle-orm");

/**
 * A shadow row is persisted for scoring and must be unreachable from the athlete's side in every
 * direction — not listed, not acceptable, not dismissable. The last two matter beyond tidiness:
 * applying one would let an engine that is switched off edit real sessions, and dismissing one
 * would write an athlete verdict onto a card the athlete was never shown, corrupting the very
 * record the row exists to collect.
 */
let userId: string;

function card(ruleId: string): RuleOutput {
  return {
    ruleId,
    severity: "yellow",
    summary: `${ruleId} summary`,
    reason: `${ruleId} reason.`,
    proposedChanges: [],
  };
}

/** Runs an ingestion regeneration, which is what writes the shadow row under test. */
async function seedViaIngestion(opts: { rules: string[]; model: string[] }) {
  ruleOutputs.current = opts.rules.map(card);
  modelOutputs.current = opts.model.map(card);
  await generateRecommendations(userId, { ingestion: true });
}

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `rec-routes-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      // Comped so the entitlement guard doesn't paywall the route out from under the assertion.
      entitlementSource: "comp" as const,
      entitlementStatus: "active" as const,
      // Pinned rather than left on inherit: the global default is shared state that another
      // suite legitimately flips, and these assertions are about the shadow path specifically.
      modelRenderedOverride: false,
    })
    .returning({ id: users.id });
  userId = user!.id;
  ruleOutputs.current = [];
  modelOutputs.current = [];
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("shadow rows are not reachable through the API", () => {
  it("omits them from the pending list while returning rules rows", async () => {
    await seedViaIngestion({ rules: ["sleep-debt"], model: ["model-note"] });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });

      expect(res.statusCode).toBe(200);
      const sources = res.json().map((r: { source: string }) => r.source);
      expect(sources).toEqual(["rules"]);
    } finally {
      await app.close();
    }
  });

  it("404s on accept and dismiss, and leaves the row pending", async () => {
    await seedViaIngestion({ rules: [], model: ["model-note"] });
    const [shadow] = await db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.source, "model")));
    const shadowId = shadow!.id;

    const app = await buildServer();
    try {
      for (const action of ["accept", "dismiss"]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/recommendations/${shadowId}/${action}`,
          cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        });
        expect(res.statusCode, action).toBe(404);
      }

      const [row] = await db
        .select({ status: recommendations.status })
        .from(recommendations)
        .where(eq(recommendations.id, shadowId));
      expect(row?.status).toBe("pending");
    } finally {
      await app.close();
    }
  });

  it("becomes reachable once the account is switched on", async () => {
    await db.update(users).set({ modelRenderedOverride: true }).where(eq(users.id, userId));
    ruleOutputs.current = [card("sleep-debt")];
    modelOutputs.current = [card("model-note")];

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });

      const sources = res.json().map((r: { source: string }) => r.source).sort();
      expect(sources).toEqual(["model", "rules"]);
    } finally {
      await app.close();
    }
  });
});
