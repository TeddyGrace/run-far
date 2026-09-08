import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

import type { RuleOutput } from "../recommendations/types.js";

/**
 * The accept path has two ways to end without applying anything, and they used to be written to
 * the same column value. "The athlete dismissed this" and "the athlete accepted, but the run had
 * already moved on" are different outcomes: a model trained on a column that conflates them
 * learns to avoid suggestions that were merely late.
 */
const ruleOutputs = vi.hoisted(() => ({ current: [] as RuleOutput[] }));

vi.mock("../recommendations/sources/rulesSource.js", () => ({
  rulesSource: { id: "rules", version: null, generate: async () => ruleOutputs.current },
}));
vi.mock("../recommendations/sources/modelSource.js", () => ({
  modelSource: { id: "model", version: "v-test", generate: async () => [] },
}));
// The apply path pushes every touched run to Google; there is no connection in a test.
vi.mock("../integrations/google/push.js", () => ({
  pushPlannedRunToGoogle: async () => undefined,
}));

const { db } = await import("../db/client.js");
const { users, plannedRuns, recommendations } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { generateRecommendations } = await import("../recommendations/service.js");
const { and, eq } = await import("drizzle-orm");

let userId: string;
let runId: string;

// Inside the engine's 10-day lookahead, so the run is actually in RuleContext.upcoming — a rule
// can only propose changes to runs it saw there, and decisionContext records what it saw.
const ORIGINAL_START = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
const PROPOSED_START = new Date(ORIGINAL_START.getTime() + 3 * 60 * 60 * 1000);
const EDITED_START = new Date(ORIGINAL_START.getTime() + 6 * 60 * 60 * 1000);

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `rec-stale-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      entitlementSource: "comp" as const,
      entitlementStatus: "active" as const,
      modelRenderedOverride: false,
    })
    .returning({ id: users.id });
  userId = user!.id;

  const [run] = await db
    .insert(plannedRuns)
    .values({ userId, scheduledAt: ORIGINAL_START, runType: "easy", durationMin: 60 })
    .returning({ id: plannedRuns.id });
  runId = run!.id;

  ruleOutputs.current = [
    {
      ruleId: "calendar-conflict",
      severity: "info",
      summary: "Your easy run conflicts with your calendar",
      reason: "That easy run overlaps your calendar.",
      proposedChanges: [
        {
          plannedRunId: runId,
          field: "scheduledAt",
          from: ORIGINAL_START.toISOString(),
          to: PROPOSED_START.toISOString(),
        },
      ],
    },
  ];
  await generateRecommendations(userId);
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

async function acceptCard() {
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")));
  const app = await buildServer();
  try {
    return {
      rec,
      res: await app.inject({
        method: "POST",
        url: `/api/recommendations/${rec!.id}/accept`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      }),
    };
  } finally {
    await app.close();
  }
}

async function statusOf(id: string) {
  const [row] = await db.select().from(recommendations).where(eq(recommendations.id, id));
  return row;
}

describe("POST /api/recommendations/:id/accept — stale split", () => {
  it("writes `stale`, not `dismissed`, when every change was overtaken by an edit", async () => {
    // The athlete drags the run to a new time after the card was minted, so the change's `from`
    // no longer matches — applying it would silently revert that drag.
    await db
      .update(plannedRuns)
      .set({ scheduledAt: EDITED_START })
      .where(eq(plannedRuns.id, runId));

    const { rec, res } = await acceptCard();

    // Response is unchanged, so the SPA needs no change.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("STALE_RECOMMENDATION");

    const row = await statusOf(rec!.id);
    expect(row?.status).toBe("stale");
    expect(row?.status).not.toBe("dismissed");
    expect(row?.appliedAt).toBeInstanceOf(Date);
  });

  it("still writes `accepted` when the change applies cleanly", async () => {
    const { rec, res } = await acceptCard();

    expect(res.statusCode).toBe(200);
    const row = await statusOf(rec!.id);
    expect(row?.status).toBe("accepted");

    const [run] = await db.select().from(plannedRuns).where(eq(plannedRuns.id, runId));
    expect(run?.scheduledAt).toEqual(PROPOSED_START);
  });

  it("still writes `dismissed` when the athlete actually dismisses", async () => {
    const [rec] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")));

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/recommendations/${rec!.id}/dismiss`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    // The two paths are now distinguishable, which is the whole point.
    expect((await statusOf(rec!.id))?.status).toBe("dismissed");
  });
});

describe("decision context", () => {
  it("records the target run as the engine saw it, without calendar event titles", async () => {
    const [rec] = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")));

    const ctx = rec?.decisionContext as {
      targetRuns: Array<Record<string, unknown>>;
      conflictWindows: Array<Record<string, unknown>>;
    };

    expect(ctx.targetRuns).toHaveLength(1);
    expect(ctx.targetRuns[0]).toMatchObject({
      id: runId,
      runType: "easy",
      durationMin: 60,
      scheduledAt: ORIGINAL_START.toISOString(),
      status: "planned",
    });
    // No Google connection in this test, so there are no busy periods to record.
    expect(ctx.conflictWindows).toEqual([]);
  });
});
