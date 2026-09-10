import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

import type { RuleOutput } from "./types.js";

/**
 * Covers the training record itself: that a card which stops firing leaves an interpretable
 * trace instead of vanishing, that the trace can't leak into anything the athlete sees, and
 * that expiry doesn't suppress the card's own return.
 *
 * The sources are stubbed so a rule can be made to stop firing on demand — which is the event
 * under test and is otherwise hard to stage through the real engine.
 */
const ruleOutputs = vi.hoisted(() => ({ current: [] as RuleOutput[] }));
const sentMail = vi.hoisted(() => ({ last: null as { html: string; text: string } | null }));
const busy = vi.hoisted(() => ({ current: [] as Array<{ start: Date; end: Date; summary?: string }> }));

vi.mock("./sources/rulesSource.js", () => ({
  rulesSource: { id: "rules", version: null, generate: async () => ruleOutputs.current },
}));
vi.mock("./sources/modelSource.js", () => ({
  modelSource: { id: "model", version: "v-test", generate: async () => [] },
}));
vi.mock("../integrations/google/calendarClient.js", () => ({
  // The engine reads through the cached wrapper; stubbing it directly is what keeps these
  // fixtures deterministic, since a real TTL cache would carry one test's busy periods into
  // the next.
  getPrimaryBusyPeriodsCached: async () => busy.current,
  getPrimaryBusyPeriods: async () => busy.current,
}));
vi.mock("../lib/mailer.js", () => ({
  sendMail: async (msg: { html: string; text: string }) => {
    sentMail.last = { html: msg.html, text: msg.text };
  },
}));

const { db } = await import("../db/client.js");
const { users, recommendations, plannedRuns, oauthConnections } = await import("../db/schema.js");
const { generateRecommendations } = await import("./service.js");
const { sendRecoveryDigestNow } = await import("../email/recoveryDigest.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { and, eq } = await import("drizzle-orm");

let userId: string;

function card(overrides: Partial<RuleOutput> & Pick<RuleOutput, "ruleId">): RuleOutput {
  return {
    severity: "yellow",
    summary: `${overrides.ruleId} summary`,
    reason: `${overrides.ruleId} reason.`,
    proposedChanges: [],
    ...overrides,
  };
}

async function allRows() {
  return db
    .select()
    .from(recommendations)
    .where(eq(recommendations.userId, userId))
    .orderBy(recommendations.createdAt);
}

async function rowFor(ruleId: string) {
  const found = (await allRows()).filter((r) => r.ruleId === ruleId);
  return found;
}

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `training-record-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      // Comped so the entitlement guard doesn't paywall the GET route out from under the tests.
      entitlementSource: "comp" as const,
      entitlementStatus: "active" as const,
      // Pinned: the global default is shared state another suite legitimately flips, and these
      // assertions are about the rules source only.
      modelRenderedOverride: false,
    })
    .returning({ id: users.id });
  userId = user!.id;
  ruleOutputs.current = [];
  sentMail.last = null;
  busy.current = [];
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("retraction", () => {
  it("expires a card whose rule stopped firing instead of deleting the row", async () => {
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    await generateRecommendations(userId);

    ruleOutputs.current = [];
    await generateRecommendations(userId);

    // The outcome this whole change exists to keep: "shown it, didn't act, the situation
    // passed" used to leave no trace at all.
    const rows = await rowFor("sleep-debt");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("expired");
    expect(rows[0]?.appliedAt).toBeInstanceOf(Date);
  });

  it("keeps an expired card out of the dashboard, the digest and the pending query", async () => {
    ruleOutputs.current = [card({ ruleId: "sleep-debt", summary: "Sleep debt is climbing" })];
    await generateRecommendations(userId);
    ruleOutputs.current = [];
    await generateRecommendations(userId);

    // Every consumer filters explicitly on `pending`, which is what makes widening the enum
    // safe — assert that rather than trusting it.
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }

    await sendRecoveryDigestNow(userId);
    expect(sentMail.last).not.toBeNull();
    expect(sentMail.last?.html).not.toContain("Sleep debt is climbing");
    expect(sentMail.last?.text).not.toContain("Sleep debt is climbing");

    // The assistant's get_recommendations tool runs this same predicate (assistantChat.ts).
    const pending = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")));
    expect(pending).toEqual([]);
  });
});

describe("suppression", () => {
  it("lets an expired card fire again immediately on an unchanged fingerprint", async () => {
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    await generateRecommendations(userId);

    ruleOutputs.current = [];
    await generateRecommendations(userId);

    // Same card, same fingerprint, well inside the 14-day suppression window. Suppression
    // filters on ("dismissed", "accepted") only — an expired card is free to come back,
    // because expiry is not a verdict the athlete gave.
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    await generateRecommendations(userId);

    const rows = await rowFor("sleep-debt");
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("still suppresses an accepted or dismissed card inside the window", async () => {
    for (const status of ["accepted", "dismissed"] as const) {
      ruleOutputs.current = [card({ ruleId: `rule-${status}` })];
      await generateRecommendations(userId);

      await db
        .update(recommendations)
        .set({ status, appliedAt: new Date() })
        .where(and(eq(recommendations.userId, userId), eq(recommendations.ruleId, `rule-${status}`)));

      await generateRecommendations(userId);

      const rows = await rowFor(`rule-${status}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe(status);
    }
  });

  it("coexists with a fresh pending row without violating the pending unique index", async () => {
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    await generateRecommendations(userId);
    ruleOutputs.current = [];
    await generateRecommendations(userId);
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    await generateRecommendations(userId);

    // The index is partial (WHERE status = 'pending'), so the expired row drops out of it and
    // the re-fire inserts alongside rather than colliding — a genuinely new showing, which is
    // also why flapping rules now mint a row per cycle.
    const rows = await rowFor("sleep-debt");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["expired", "pending"]);
  });
});

describe("first-shown stamping", () => {
  it("is null until the first GET, then stamped once and never re-stamped", async () => {
    ruleOutputs.current = [card({ ruleId: "sleep-debt" })];
    await generateRecommendations(userId);

    // Generation alone is not a showing — this is what separates "never seen" from
    // "seen and ignored" once the row expires.
    expect((await rowFor("sleep-debt"))[0]?.firstShownAt).toBeNull();

    const app = await buildServer();
    try {
      const read = async () => {
        const res = await app.inject({
          method: "GET",
          url: "/api/recommendations",
          cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        });
        expect(res.statusCode).toBe(200);
        return res.json();
      };

      const first = await read();
      expect(first).toHaveLength(1);
      // The response reflects the pre-stamp value; nothing consumes it.
      expect(first[0].firstShownAt).toBeNull();

      const stamped = (await rowFor("sleep-debt"))[0]?.firstShownAt;
      expect(stamped).toBeInstanceOf(Date);

      await read();

      // First-shown, not last-shown: the IS NULL guard is what keeps the original instant.
      expect((await rowFor("sleep-debt"))[0]?.firstShownAt).toEqual(stamped);
    } finally {
      await app.close();
    }
  });
});

describe("decision context persistence", () => {
  it("stores the conflicting calendar windows but never the event titles", async () => {
    // hasGoogleConnection gates the busy-period fetch; the client itself is stubbed above.
    await db.insert(oauthConnections).values({
      userId,
      provider: "google" as const,
      accessTokenEnc: "x",
      refreshTokenEnc: "x",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const [run] = await db
      .insert(plannedRuns)
      .values({ userId, scheduledAt: start, runType: "easy", durationMin: 60 })
      .returning({ id: plannedRuns.id });

    busy.current = [
      // Overlaps the run's second half.
      {
        start: new Date(start.getTime() + 30 * 60_000),
        end: new Date(start.getTime() + 90 * 60_000),
        summary: "Oncology appointment",
      },
      // Well clear of it — must not be recorded.
      {
        start: new Date(start.getTime() + 8 * 60 * 60_000),
        end: new Date(start.getTime() + 9 * 60 * 60_000),
        summary: "Dinner with Sam",
      },
    ];

    ruleOutputs.current = [
      card({
        ruleId: "calendar-conflict",
        proposedChanges: [
          {
            plannedRunId: run!.id,
            field: "scheduledAt",
            from: start.toISOString(),
            to: new Date(start.getTime() + 3 * 60 * 60_000).toISOString(),
          },
        ],
      }),
    ];
    await generateRecommendations(userId);

    const [row] = await rowFor("calendar-conflict");
    const ctx = row?.decisionContext as {
      targetRuns: Array<{ id: string }>;
      conflictWindows: Array<{ start: string; end: string }>;
    };

    expect(ctx.targetRuns.map((r) => r.id)).toEqual([run!.id]);
    expect(ctx.conflictWindows).toEqual([
      {
        start: new Date(start.getTime() + 30 * 60_000).toISOString(),
        end: new Date(start.getTime() + 90 * 60_000).toISOString(),
      },
    ]);

    // The guarantee, asserted against what actually landed in the column: a calendar event
    // title must not be reachable from a long-lived training table.
    const persisted = JSON.stringify(row?.decisionContext);
    expect(persisted).not.toContain("Oncology");
    expect(persisted).not.toContain("Dinner with Sam");
    expect(persisted).not.toContain("summary");
  });
});
