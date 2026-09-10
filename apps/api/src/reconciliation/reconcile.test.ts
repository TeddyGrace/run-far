import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";
process.env.ATHLETE_TIMEZONE ??= "America/New_York";

/**
 * The sweep against a real database.
 *
 * match.test.ts pins the heuristic; this pins what the sweep *does* with it — which is the part
 * that can lose data. Three things here are unrecoverable if they go wrong and so are asserted
 * directly rather than inferred: an athlete's manual correction surviving later passes, a
 * deleted workout un-completing the run it used to satisfy, and the sweep leaving `updated_at`
 * alone so Google's inbound conflict detection keeps working.
 */
const { db } = await import("../db/client.js");
const { users, plannedRuns, whoopWorkouts, trainingPlans, recommendations, recoveryMetrics } =
  await import("../db/schema.js");
const { reconcileUser } = await import("./service.js");
const { buildAdherence } = await import("./adherence.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { and, eq } = await import("drizzle-orm");

const TZ = "America/New_York";
/** Fixed "now": a Wednesday in EDT, so -04:00 is New York's offset throughout. */
const NOW = new Date("2025-06-11T15:00:00-04:00");
const local = (s: string) => new Date(`${s}-04:00`);

let userId: string;
let planId: string;

async function addRun(
  scheduledAt: Date,
  overrides: Partial<typeof plannedRuns.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(plannedRuns)
    .values({
      userId,
      planId,
      scheduledAt,
      runType: "easy",
      distanceM: 10_000,
      durationMin: 55,
      origin: "imported",
      ...overrides,
    })
    .returning({ id: plannedRuns.id });
  return row!.id;
}

async function addWorkout(
  date: string,
  startedAt: Date | null,
  overrides: Partial<typeof whoopWorkouts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(whoopWorkouts)
    .values({
      userId,
      whoopWorkoutId: randomUUID(),
      date,
      startedAt,
      sport: "running",
      distanceM: 9_500,
      durationMin: 52,
      strain: 11.4,
      ...overrides,
    })
    .returning({ id: whoopWorkouts.id });
  return row!.id;
}

async function readRun(id: string) {
  const [row] = await db.select().from(plannedRuns).where(eq(plannedRuns.id, id));
  return row!;
}

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `reconcile-${randomUUID()}@run-far.local`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      timezone: TZ,
      entitlementSource: "comp" as const,
      entitlementStatus: "active" as const,
    })
    .returning({ id: users.id });
  userId = user!.id;

  const [plan] = await db
    .insert(trainingPlans)
    .values({ userId, name: "Test block", status: "active" })
    .returning({ id: trainingPlans.id });
  planId = plan!.id;
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("reconcileUser", () => {
  it("completes a past run that a workout on the same day matches", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const workoutId = await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));

    const result = await reconcileUser(userId, { now: NOW });

    expect(result.completed).toBe(1);
    const run = await readRun(runId);
    expect(run.status).toBe("completed");
    expect(run.actualWorkoutId).toBe(workoutId);
    expect(run.matchSource).toBe("auto");
    expect(run.reconciledAt).toBeInstanceOf(Date);
  });

  it("marks a past run with no workout as skipped, and stamps it so that is distinguishable from unexamined", async () => {
    const runId = await addRun(local("2025-06-09T07:00:00"));

    await reconcileUser(userId, { now: NOW });

    const run = await readRun(runId);
    expect(run.status).toBe("skipped");
    expect(run.actualWorkoutId).toBeNull();
    // The pair (reconciled_at set, workout null) is the whole point: "we looked, nothing
    // matched" rather than "no pass has reached this run yet".
    expect(run.reconciledAt).toBeInstanceOf(Date);
  });

  it("leaves today's unmatched run undecided rather than calling it skipped", async () => {
    const runId = await addRun(local("2025-06-11T18:00:00"));

    await reconcileUser(userId, { now: NOW });

    const run = await readRun(runId);
    expect(run.status).toBe("planned");
    expect(run.reconciledAt).toBeNull();
  });

  it("never touches a rest day", async () => {
    const runId = await addRun(local("2025-06-09T07:00:00"), {
      runType: "rest",
      distanceM: null,
      durationMin: null,
    });

    await reconcileUser(userId, { now: NOW });

    const run = await readRun(runId);
    expect(run.status).toBe("planned");
    expect(run.reconciledAt).toBeNull();
  });

  it("is idempotent: a second pass changes nothing", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));

    await reconcileUser(userId, { now: NOW });
    const first = await readRun(runId);
    const second = await reconcileUser(userId, { now: NOW });
    const after = await readRun(runId);

    expect(second.completed).toBe(1);
    expect(after.actualWorkoutId).toBe(first.actualWorkoutId);
    expect(after.status).toBe("completed");
  });

  it("un-completes a run whose workout was deleted", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const workoutId = await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));
    await reconcileUser(userId, { now: NOW });
    expect((await readRun(runId)).status).toBe("completed");

    await db.delete(whoopWorkouts).where(eq(whoopWorkouts.id, workoutId));
    await reconcileUser(userId, { now: NOW });

    // Without this the run keeps reading as completed off a workout that no longer exists and
    // adherence permanently overstates what was done.
    const run = await readRun(runId);
    expect(run.status).toBe("skipped");
    expect(run.actualWorkoutId).toBeNull();
  });

  it("reassigns a workout between two runs without tripping the one-workout-one-run index", async () => {
    // The morning run owns the workout on the first pass. Deleting it must let the evening run
    // claim the same workout on the next pass rather than the update colliding.
    const amId = await addRun(local("2025-06-10T06:00:00"));
    const pmId = await addRun(local("2025-06-10T18:00:00"));
    const workoutId = await addWorkout("2025-06-10", local("2025-06-10T06:10:00"));

    await reconcileUser(userId, { now: NOW });
    expect((await readRun(amId)).actualWorkoutId).toBe(workoutId);

    await db.delete(plannedRuns).where(eq(plannedRuns.id, amId));
    await reconcileUser(userId, { now: NOW });

    expect((await readRun(pmId)).actualWorkoutId).toBe(workoutId);
  });

  it("does not move updated_at, so Google's inbound conflict detection is unaffected", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));
    const before = (await readRun(runId)).updatedAt;

    await reconcileUser(userId, { now: NOW });

    // pull.ts reads `existing.updatedAt > syncState.updatedAt` as "the app changed this run".
    // A background sweep bumping it would make every inbound calendar edit look like a
    // conflict, and app-wins would then overwrite the athlete's own Google-side edit.
    expect((await readRun(runId)).updatedAt.getTime()).toBe(before.getTime());
  });

  it("ignores runs belonging to a plan that is no longer active", async () => {
    const [other] = await db
      .insert(trainingPlans)
      .values({ userId, name: "Old block", status: "inactive" })
      .returning({ id: trainingPlans.id });
    const [stale] = await db
      .insert(plannedRuns)
      .values({
        userId,
        planId: other!.id,
        scheduledAt: local("2025-06-10T07:00:00"),
        runType: "easy",
        origin: "imported",
      })
      .returning({ id: plannedRuns.id });
    const activeId = await addRun(local("2025-06-10T07:00:00"));
    const workoutId = await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));

    await reconcileUser(userId, { now: NOW });

    // A dormant plan's runs must not compete with the live plan's for the same workout.
    expect((await readRun(activeId)).actualWorkoutId).toBe(workoutId);
    expect((await readRun(stale!.id)).actualWorkoutId).toBeNull();
    expect((await readRun(stale!.id)).reconciledAt).toBeNull();
  });
});

describe("manual corrections", () => {
  it("survives every later sweep", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const autoWorkout = await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));
    const realWorkout = await addWorkout("2025-06-10", local("2025-06-10T19:00:00"));

    await reconcileUser(userId, { now: NOW });
    expect((await readRun(runId)).actualWorkoutId).toBe(autoWorkout);

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/runs/${runId}/actual`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { workoutId: realWorkout },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    await reconcileUser(userId, { now: NOW });

    const run = await readRun(runId);
    expect(run.actualWorkoutId).toBe(realWorkout);
    expect(run.matchSource).toBe("manual");
  });

  it("withholds a manually claimed workout from other runs", async () => {
    const claimedId = await addRun(local("2025-06-10T06:00:00"));
    const otherId = await addRun(local("2025-06-10T18:00:00"));
    const workoutId = await addWorkout("2025-06-10", local("2025-06-10T17:50:00"));

    // Left to itself the sweep would give this workout to the evening run — it is 10 minutes
    // away. The athlete says it belonged to the morning one.
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/runs/${claimedId}/actual`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { workoutId },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    await reconcileUser(userId, { now: NOW });

    expect((await readRun(claimedId)).actualWorkoutId).toBe(workoutId);
    expect((await readRun(otherId)).actualWorkoutId).toBeNull();
    expect((await readRun(otherId)).status).toBe("skipped");
  });

  it("lets the athlete mark a run skipped and keeps the sweep from reopening it", async () => {
    const runId = await addRun(local("2025-06-11T06:00:00"));

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/runs/${runId}/actual`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { workoutId: null, status: "skipped" },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    // Today's runs are normally reopened as undecided. A manual verdict outranks that.
    await reconcileUser(userId, { now: NOW });
    expect((await readRun(runId)).status).toBe("skipped");
  });
});

describe("adherence", () => {
  it("counts settled runs only, and reports planned against actual volume", async () => {
    await addRun(local("2025-06-09T07:00:00")); // skipped
    await addRun(local("2025-06-10T07:00:00")); // completed
    await addRun(local("2025-06-11T18:00:00")); // still open today
    await addWorkout("2025-06-10", local("2025-06-10T07:05:00"), {
      distanceM: 9_000,
      durationMin: 50,
    });

    await reconcileUser(userId, { now: NOW });
    const { summary, runs } = await buildAdherence(userId, { windowDays: 14, now: NOW });

    expect(summary.counts).toEqual({ total: 3, completed: 1, skipped: 1, open: 1 });
    // 1 of 2 settled — the run still ahead of the athlete today is deliberately not counted
    // against them.
    expect(summary.completionRate).toBe(0.5);
    expect(summary.plannedDistanceM).toBe(30_000);
    expect(summary.actualDistanceM).toBe(9_000);

    const completed = runs.find((r) => r.status === "completed");
    expect(completed?.distanceDeltaM).toBe(-1_000);
    expect(completed?.durationDeltaMin).toBe(-5);
  });

  it("offers unclaimed run workouts for correction, and excludes non-run ones", async () => {
    await addRun(local("2025-06-10T07:00:00"));
    await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));
    await addWorkout("2025-06-08", local("2025-06-08T09:00:00"));
    await addWorkout("2025-06-08", local("2025-06-08T17:00:00"), { sport: "weightlifting" });

    await reconcileUser(userId, { now: NOW });
    const { unmatchedWorkouts } = await buildAdherence(userId, { windowDays: 14, now: NOW });

    expect(unmatchedWorkouts).toHaveLength(1);
    expect(unmatchedWorkouts[0]?.date).toBe("2025-06-08");
  });

  it("excludes rest days from the denominator", async () => {
    await addRun(local("2025-06-09T07:00:00"), { runType: "rest", distanceM: null });
    await addRun(local("2025-06-10T07:00:00"));
    await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));

    await reconcileUser(userId, { now: NOW });
    const { summary } = await buildAdherence(userId, { windowDays: 14, now: NOW });

    expect(summary.counts.total).toBe(1);
    expect(summary.completionRate).toBe(1);
  });
});

describe("recommendation outcomes", () => {
  async function addResolvedCard(
    date: string,
    targetRunId: string | null,
    status: "accepted" | "dismissed" = "accepted",
  ): Promise<string> {
    const [row] = await db
      .insert(recommendations)
      .values({
        userId,
        date,
        ruleId: `rule-${randomUUID().slice(0, 8)}`,
        severity: "yellow",
        summary: "s",
        reason: "r",
        inputSnapshot: { date, recoveryScore: 40 },
        proposedChanges: targetRunId
          ? [{ plannedRunId: targetRunId, field: "runType", from: "tempo", to: "easy" }]
          : [],
        status,
        appliedAt: new Date(`${date}T18:00:00Z`),
      })
      .returning({ id: recommendations.id });
    return row!.id;
  }

  async function readCard(id: string) {
    const [row] = await db.select().from(recommendations).where(eq(recommendations.id, id));
    return row!;
  }

  it("records what happened to the targeted run and the next morning's recovery", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    await addWorkout("2025-06-10", local("2025-06-10T07:05:00"), {
      distanceM: 6_000,
      durationMin: 35,
      strain: 8.2,
    });
    const cardId = await addResolvedCard("2025-06-10", runId);
    await db.insert(recoveryMetrics).values({
      userId,
      whoopSleepId: randomUUID(),
      date: "2025-06-11",
      recoveryScore: 72,
      hrvRmssdMs: 61.5,
    });

    await reconcileUser(userId, { now: NOW });

    const outcome = (await readCard(cardId)).outcomeContext as {
      runs: Array<{ status: string; actualDistanceM: number | null; reconciled: boolean }>;
      nextDayRecoveryScore: number | null;
      complete: boolean;
    };
    // The label the status column can't carry: they accepted, and the session that followed
    // was actually run — 6k of it — and they woke up at 72.
    expect(outcome.runs).toHaveLength(1);
    expect(outcome.runs[0]).toMatchObject({
      status: "completed",
      actualDistanceM: 6_000,
      reconciled: true,
    });
    expect(outcome.nextDayRecoveryScore).toBe(72);
    expect(outcome.complete).toBe(true);
  });

  it("records an advisory card with no proposed changes", async () => {
    const cardId = await addResolvedCard("2025-06-10", null, "dismissed");

    await reconcileUser(userId, { now: NOW });

    const outcome = (await readCard(cardId)).outcomeContext as { runs: unknown[] } | null;
    // A card that proposed nothing still has an outcome — whether ignoring it cost anything.
    expect(outcome?.runs).toEqual([]);
  });

  it("leaves a pending card alone", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const [row] = await db
      .insert(recommendations)
      .values({
        userId,
        date: "2025-06-10",
        ruleId: "still-open",
        severity: "yellow",
        summary: "s",
        reason: "r",
        inputSnapshot: {},
        proposedChanges: [{ plannedRunId: runId, field: "runType", from: "tempo", to: "easy" }],
        status: "pending",
      })
      .returning({ id: recommendations.id });

    await reconcileUser(userId, { now: NOW });

    expect((await readCard(row!.id)).outcomeContext).toBeNull();
  });

  it("does not record a card whose own day is not over", async () => {
    const runId = await addRun(local("2025-06-11T07:00:00"));
    const cardId = await addResolvedCard("2025-06-11", runId);

    await reconcileUser(userId, { now: NOW });

    // There is no "next morning" yet to read a verdict from.
    expect((await readCard(cardId)).outcomeContext).toBeNull();
  });

  it("writes the outcome once and never revises it", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const workoutId = await addWorkout("2025-06-10", local("2025-06-10T07:05:00"));
    const cardId = await addResolvedCard("2025-06-10", runId);

    await reconcileUser(userId, { now: NOW });
    const first = (await readCard(cardId)).outcomeContext as { recordedAt: string };

    // Delete the workout so a re-derivation would produce a materially different record.
    await db.delete(whoopWorkouts).where(eq(whoopWorkouts.id, workoutId));
    await reconcileUser(userId, { now: NOW });

    const second = (await readCard(cardId)).outcomeContext as {
      recordedAt: string;
      runs: Array<{ status: string }>;
    };
    // A label that kept moving would silently change the target under any model already
    // scored against it.
    expect(second.recordedAt).toBe(first.recordedAt);
    expect(second.runs[0]?.status).toBe("completed");
  });

  it("records a card whose targeted run was deleted outright", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const cardId = await addResolvedCard("2025-06-10", runId);
    await db.delete(plannedRuns).where(eq(plannedRuns.id, runId));

    await reconcileUser(userId, { now: NOW });

    const outcome = (await readCard(cardId)).outcomeContext as {
      runs: Array<{ status: string }>;
      complete: boolean;
    };
    // Otherwise the retained set quietly skews toward the tidy cases — the same bias that
    // deleting expired cards used to introduce.
    expect(outcome.runs[0]?.status).toBe("deleted");
    expect(outcome.complete).toBe(false);
  });
});

describe("route access", () => {
  it("refuses another athlete's run", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const [intruder] = await db
      .insert(users)
      .values({
        email: `intruder-${randomUUID()}@run-far.local`,
        passwordHash: "x",
        emailVerifiedAt: new Date(),
        entitlementSource: "comp" as const,
        entitlementStatus: "active" as const,
      })
      .returning({ id: users.id });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/runs/${runId}/actual`,
        cookies: { [SESSION_COOKIE]: app.signCookie(intruder!.id) },
        payload: { workoutId: null, status: "skipped" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
      await db.delete(users).where(eq(users.id, intruder!.id));
    }

    expect((await readRun(runId)).status).toBe("planned");
  });

  it("refuses to link a workout belonging to someone else", async () => {
    const runId = await addRun(local("2025-06-10T07:00:00"));
    const [other] = await db
      .insert(users)
      .values({
        email: `other-${randomUUID()}@run-far.local`,
        passwordHash: "x",
        emailVerifiedAt: new Date(),
        entitlementSource: "comp" as const,
        entitlementStatus: "active" as const,
      })
      .returning({ id: users.id });
    const [theirWorkout] = await db
      .insert(whoopWorkouts)
      .values({
        userId: other!.id,
        whoopWorkoutId: randomUUID(),
        date: "2025-06-10",
        sport: "running",
      })
      .returning({ id: whoopWorkouts.id });

    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/runs/${runId}/actual`,
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { workoutId: theirWorkout!.id },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
      await db.delete(users).where(eq(users.id, other!.id));
    }

    expect(await db
      .select()
      .from(plannedRuns)
      .where(and(eq(plannedRuns.id, runId), eq(plannedRuns.userId, userId)))
      .then((r) => r[0]?.actualWorkoutId)).toBeNull();
  });
});
