import { and, eq, inArray, isNull, lt, ne } from "drizzle-orm";

import { db } from "../db/client.js";
import { plannedRuns, recommendations, recoveryMetrics, whoopWorkouts } from "../db/schema.js";
import { dateYmdInZone } from "../lib/zonedTime.js";

/**
 * What became of the advice, rather than what became of the card.
 *
 * `status` records the click and stops there: accepted, dismissed, expired, stale. That is the
 * athlete's verdict on the suggestion, not the world's. Whether the athlete who accepted
 * "downgrade tomorrow's tempo" actually went out and ran easy, and what their recovery looked
 * like the next morning, is the part that says whether the advice was any good — and it is only
 * knowable once the targeted runs have been reconciled against what was really done.
 *
 * Written once and never revised, like the rest of the training record: an outcome that kept
 * being recomputed would silently change the label under any model already scored on it.
 */
export interface RunOutcome {
  plannedRunId: string;
  /** Terminal status of the run itself — 'completed', 'skipped', or whatever it was left at. */
  status: string;
  /** False when this run was still undecided at the deadline; see `complete` below. */
  reconciled: boolean;
  plannedDistanceM: number | null;
  plannedDurationMin: number | null;
  actualDistanceM: number | null;
  actualDurationMin: number | null;
  actualStrain: number | null;
  actualAvgHr: number | null;
}

export interface OutcomeContext {
  recordedAt: string;
  /** One entry per run the card proposed changing. Empty for advisory cards, which propose
   * nothing — those still get a row, because the next morning's recovery is a real outcome
   * for a card that only said "you're green, consider going harder". */
  runs: RunOutcome[];
  /** Recovery the morning after the card's own date: the nearest thing to a physiological
   * verdict on the day the advice was about. Null when Whoop has no row for that date. */
  nextDayRecoveryScore: number | null;
  nextDayHrvRmssdMs: number | null;
  /** True when every targeted run was reconciled with real data at the time this was written.
   * False means something is missing rather than negative — a run still undecided when the
   * deadline forced the record out, or one deleted before it could be reconciled. A consumer
   * training on these should filter on it; an unreconciled run is missing data, not a skipped
   * session. */
  complete: boolean;
}

/** Terminal statuses whose outcome is worth recording. All four are training examples: an
 * accepted card asks "did this help?", a dismissed or expired one asks "did ignoring it hurt?" */
const TERMINAL_STATUSES = ["accepted", "dismissed", "expired", "stale"] as const;

/**
 * How long to wait for the targeted runs to settle before recording anyway. Without a deadline
 * a card whose run was deleted outright would stay unrecorded forever, quietly biasing the
 * retained set toward the tidy cases.
 */
const SETTLE_DEADLINE_DAYS = 4;

/** Next calendar day of a YYYY-MM-DD string. Plain calendar arithmetic — the value is already
 * an athlete-local date, so no timezone is involved in stepping it forward. */
function nextYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function daysBetweenYmd(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function targetRunIds(proposedChanges: unknown): string[] {
  if (!Array.isArray(proposedChanges)) return [];
  const ids = proposedChanges
    .map((c) => (c as { plannedRunId?: unknown })?.plannedRunId)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

/**
 * Fill in `outcome_context` for every resolved recommendation whose targeted runs have settled.
 *
 * Called from the reconciliation sweep, because runs settling is exactly the event that makes an
 * outcome knowable. Only ever writes rows where the column is still null, so it is safe to run
 * as often as reconciliation does.
 */
export async function recordSettledOutcomes(
  userId: string,
  opts: { now?: Date; timeZone: string },
): Promise<number> {
  const now = opts.now ?? new Date();
  const todayYmd = dateYmdInZone(now, opts.timeZone);

  const candidates = await db
    .select({
      id: recommendations.id,
      date: recommendations.date,
      proposedChanges: recommendations.proposedChanges,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.userId, userId),
        ne(recommendations.status, "pending"),
        inArray(recommendations.status, [...TERMINAL_STATUSES]),
        isNull(recommendations.outcomeContext),
        // The card's own day must be over before there is a "next morning" to read.
        lt(recommendations.date, todayYmd),
      ),
    );
  if (candidates.length === 0) return 0;

  const allRunIds = [...new Set(candidates.flatMap((c) => targetRunIds(c.proposedChanges)))];
  const runsById = new Map<
    string,
    {
      status: string;
      reconciledAt: Date | null;
      plannedDistanceM: number | null;
      plannedDurationMin: number | null;
      actualDistanceM: number | null;
      actualDurationMin: number | null;
      actualStrain: number | null;
      actualAvgHr: number | null;
    }
  >();
  if (allRunIds.length > 0) {
    const rows = await db
      .select({
        id: plannedRuns.id,
        status: plannedRuns.status,
        reconciledAt: plannedRuns.reconciledAt,
        plannedDistanceM: plannedRuns.distanceM,
        plannedDurationMin: plannedRuns.durationMin,
        actualDistanceM: whoopWorkouts.distanceM,
        actualDurationMin: whoopWorkouts.durationMin,
        actualStrain: whoopWorkouts.strain,
        actualAvgHr: whoopWorkouts.avgHr,
      })
      .from(plannedRuns)
      .leftJoin(whoopWorkouts, eq(plannedRuns.actualWorkoutId, whoopWorkouts.id))
      .where(and(eq(plannedRuns.userId, userId), inArray(plannedRuns.id, allRunIds)));
    for (const r of rows) runsById.set(r.id, r);
  }

  const nextDays = [...new Set(candidates.map((c) => nextYmd(c.date)))];
  const recoveryByDate = new Map<string, { recoveryScore: number | null; hrvRmssdMs: number | null }>();
  const recoveryRows = await db
    .select({
      date: recoveryMetrics.date,
      recoveryScore: recoveryMetrics.recoveryScore,
      hrvRmssdMs: recoveryMetrics.hrvRmssdMs,
    })
    .from(recoveryMetrics)
    .where(and(eq(recoveryMetrics.userId, userId), inArray(recoveryMetrics.date, nextDays)));
  for (const r of recoveryRows) recoveryByDate.set(r.date, r);

  let written = 0;
  for (const card of candidates) {
    const ids = targetRunIds(card.proposedChanges);
    const runs: RunOutcome[] = [];
    // Two distinct questions, and conflating them is wrong in both directions. `settled` gates
    // whether to write at all: is there anything still to wait for? `complete` describes the
    // record that gets written: is every run in it backed by real reconciled data? A deleted
    // run is settled — waiting longer will never produce more — but it is not complete.
    let allSettled = true;
    let allComplete = true;
    for (const id of ids) {
      const run = runsById.get(id);
      if (!run) {
        // The run was deleted outright. That is itself an outcome — the session the card was
        // about no longer exists — so it is recorded now rather than blocking the row until the
        // deadline, but it is not counted as complete data.
        allComplete = false;
        runs.push({
          plannedRunId: id,
          status: "deleted",
          reconciled: false,
          plannedDistanceM: null,
          plannedDurationMin: null,
          actualDistanceM: null,
          actualDurationMin: null,
          actualStrain: null,
          actualAvgHr: null,
        });
        continue;
      }
      const reconciled = run.reconciledAt != null;
      if (!reconciled) {
        allSettled = false;
        allComplete = false;
      }
      runs.push({
        plannedRunId: id,
        status: run.status,
        reconciled,
        plannedDistanceM: run.plannedDistanceM,
        plannedDurationMin: run.plannedDurationMin,
        actualDistanceM: run.actualDistanceM,
        actualDurationMin: run.actualDurationMin,
        actualStrain: run.actualStrain,
        actualAvgHr: run.actualAvgHr,
      });
    }

    const pastDeadline = daysBetweenYmd(card.date, todayYmd) > SETTLE_DEADLINE_DAYS;
    if (!allSettled && !pastDeadline) continue;

    const recovery = recoveryByDate.get(nextYmd(card.date));
    const context: OutcomeContext = {
      recordedAt: now.toISOString(),
      runs,
      nextDayRecoveryScore: recovery?.recoveryScore ?? null,
      nextDayHrvRmssdMs: recovery?.hrvRmssdMs ?? null,
      complete: allComplete,
    };

    // The IS NULL guard makes this write-once even under a concurrent sweep, so a card's
    // recorded outcome can never be silently replaced by a later, differently-timed one.
    const updated = await db
      .update(recommendations)
      .set({ outcomeContext: context })
      .where(
        and(
          eq(recommendations.id, card.id),
          eq(recommendations.userId, userId),
          isNull(recommendations.outcomeContext),
        ),
      )
      .returning({ id: recommendations.id });
    written += updated.length;
  }

  return written;
}
