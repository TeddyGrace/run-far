import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ActualWorkout, AdherenceResponse, ReconciledRun } from "@run-far/shared";

import { api } from "../lib/api.js";
import { formatMiles } from "../lib/units.js";

const WINDOW_DAYS = 28;

/** Calendar date of an instant in the browser's own timezone, as YYYY-MM-DD.
 *
 * Workout dates arrive already bucketed into the athlete's configured timezone (see
 * toLocalDateOnly on the API side). Pairing them here assumes the browser is in that same zone,
 * which it is in every case that matters — the timezone is captured from this browser at login.
 * A mismatch only affects which candidate workouts this panel offers for a manual fix; the
 * matching that actually counts happens server-side against the athlete's real zone.
 */
function localYmd(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

/** Days between two YYYY-MM-DD dates. Plain calendar arithmetic on already-local dates. */
function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * How far from a missed session to look for the run that might have been it.
 *
 * Deliberately *not* zero. Same-day workouts are exactly what auto-matching already consumes,
 * so a same-day candidate essentially never survives to be offered here — the correction worth
 * offering is the one the matcher refuses to make on its own: Tuesday's session actually run on
 * Wednesday. Two days is wide enough to cover that and narrow enough that the athlete is being
 * asked about a plausible pairing rather than shown a list of everything they ran that week.
 */
const NEARBY_DAYS = 2;

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function workoutLabel(w: ActualWorkout): string {
  // Leads with the day, because candidates deliberately span nearby dates — "Wed 6:40am" is the
  // whole point of the offer, and a bare time would hide the part the athlete is confirming.
  const parts: string[] = [dayLabel(`${w.date}T12:00:00`)];
  if (w.startedAt) {
    parts.push(
      new Date(w.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    );
  }
  if (w.distanceM != null) parts.push(formatMiles(w.distanceM, 1));
  if (w.durationMin != null) parts.push(`${Math.round(w.durationMin)}min`);
  return parts.join(" · ") || "Untitled workout";
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="font-display text-xl font-semibold text-ink-primary">{value}</p>
      {sub && <p className="font-mono text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

/**
 * Planned versus actual for the last four weeks.
 *
 * Reads what the reconciliation sweep decided and never decides anything itself, so this panel
 * and the rows a model would train on can't drift apart. The correction control matters as much
 * as the numbers: matching is a heuristic, and an athlete disagreeing with it is both a fix to
 * the displayed figure and a labelled example of a case the heuristic got wrong.
 */
export function AdherencePanel() {
  const queryClient = useQueryClient();
  const [openFixFor, setOpenFixFor] = useState<string | null>(null);

  const adherence = useQuery<AdherenceResponse>({
    queryKey: ["runs", "adherence", WINDOW_DAYS],
    queryFn: () => api.get<AdherenceResponse>(`/runs/adherence?days=${WINDOW_DAYS}`),
  });

  const correct = useMutation({
    mutationFn: ({ runId, workoutId }: { runId: string; workoutId: string | null }) =>
      api.patch(`/runs/${runId}/actual`, { workoutId, ...(workoutId ? {} : { status: "skipped" }) }),
    onSuccess: () => {
      setOpenFixFor(null);
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const data = adherence.data;
  // Nothing planned in the window means there is no adherence to report — an empty panel
  // reading "0%" would be a worse answer than no panel.
  if (!data || data.summary.counts.total === 0) return null;

  const { summary, runs, unmatchedWorkouts } = data;
  const rate = summary.completionRate;
  const settled = summary.counts.completed + summary.counts.skipped;
  // Nothing has settled and there is a backlog the app could not observe: the honest reading is
  // "we aren't tracking this", not "you completed 0%". Showing a rate here would accuse the
  // athlete of missing sessions the app simply cannot see.
  const nothingTracked = settled === 0 && summary.counts.untracked > 0;

  const candidatesFor = (run: ReconciledRun) =>
    unmatchedWorkouts
      .filter((w) => daysApart(w.date, localYmd(run.scheduledAt)) <= NEARBY_DAYS)
      .sort(
        (a, b) =>
          daysApart(a.date, localYmd(run.scheduledAt)) -
          daysApart(b.date, localYmd(run.scheduledAt)),
      );

  // Only sessions the athlete might reasonably disagree with: marked missed, with an unclaimed
  // run recorded near enough that it could plausibly have been this one. A missed session with
  // nothing around it really was missed, and offering a fix for it would just be noise.
  const fixable = runs
    .filter((r) => r.status === "skipped" && candidatesFor(r).length > 0)
    .slice(0, 5);

  const orphanCount = unmatchedWorkouts.filter(
    (w) => !runs.some((r) => localYmd(r.scheduledAt) === w.date),
  ).length;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
          Plan adherence
        </h2>
        <span className="font-mono text-xs text-ink-muted">Last {WINDOW_DAYS} days</span>
      </div>

      {nothingTracked && (
        <p className="mb-4 rounded-lg border border-border bg-surface-2 p-3 text-sm text-ink-secondary">
          {summary.counts.untracked} past {summary.counts.untracked === 1 ? "session" : "sessions"}{" "}
          couldn&apos;t be checked — there&apos;s no synced workout data covering those days.{" "}
          <Link to="/settings" className="text-accent hover:underline">
            Connect Whoop
          </Link>{" "}
          and they&apos;ll be matched up automatically.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Completed"
          value={rate == null ? "—" : `${Math.round(rate * 100)}%`}
          sub={
            rate == null
              ? nothingTracked
                ? "not tracked"
                : "nothing settled yet"
              : `${summary.counts.completed} of ${settled}`
          }
        />
        <Stat
          label="Missed"
          value={rate == null ? "—" : String(summary.counts.skipped)}
          sub={
            [
              summary.counts.upcoming > 0 ? `${summary.counts.upcoming} still ahead` : null,
              // Surfaced next to "missed" on purpose — it is the number most easily mistaken
              // for one, and the two must never be conflated.
              summary.counts.untracked > 0 ? `${summary.counts.untracked} not tracked` : null,
            ]
              .filter(Boolean)
              .join(", ") || undefined
          }
        />
        <Stat
          label="Planned"
          value={formatMiles(summary.plannedDistanceM, 0)}
          sub={`${Math.round(summary.plannedDurationMin)}min`}
        />
        <Stat
          label="Actual"
          value={formatMiles(summary.actualDistanceM, 0)}
          sub={`${Math.round(summary.actualDurationMin)}min`}
        />
      </div>

      {fixable.length > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-sm text-ink-secondary">
            {fixable.length === 1 ? "One session was" : `${fixable.length} sessions were`} marked
            missed, but you have an unmatched run around then. Did one of these count?
          </p>
          <ul className="space-y-2">
            {fixable.map((run) => (
              <FixRow
                key={run.plannedRunId}
                run={run}
                candidates={candidatesFor(run)}
                open={openFixFor === run.plannedRunId}
                onToggle={() =>
                  setOpenFixFor(openFixFor === run.plannedRunId ? null : run.plannedRunId)
                }
                onLink={(workoutId) => correct.mutate({ runId: run.plannedRunId, workoutId })}
                pending={correct.isPending}
              />
            ))}
          </ul>
        </div>
      )}

      {orphanCount > 0 && (
        <p className="mt-4 border-t border-border pt-4 font-mono text-xs text-ink-muted">
          {orphanCount} {orphanCount === 1 ? "run" : "runs"} recorded outside the plan
        </p>
      )}
    </div>
  );
}

function FixRow({
  run,
  candidates,
  open,
  onToggle,
  onLink,
  pending,
}: {
  run: ReconciledRun;
  candidates: ActualWorkout[];
  open: boolean;
  onToggle: () => void;
  onLink: (workoutId: string) => void;
  pending: boolean;
}) {
  return (
    <li className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="font-mono text-xs text-ink-muted">{dayLabel(run.scheduledAt)}</span>{" "}
          <span className="text-sm text-ink-primary">{run.runType}</span>
          {run.plannedDistanceM != null && (
            <span className="ml-2 font-mono text-xs text-ink-muted">
              {formatMiles(run.plannedDistanceM, 1)} planned
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-ink-secondary hover:text-ink-primary"
        >
          {open ? "Cancel" : "Link a run"}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-1">
          {candidates.map((w) => (
            <button
              key={w.id}
              type="button"
              disabled={pending}
              onClick={() => onLink(w.id)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-ink-secondary hover:bg-surface-1 hover:text-ink-primary disabled:opacity-50"
            >
              <span className="font-mono text-xs">{workoutLabel(w)}</span>
              <span className="font-mono text-xs text-accent">Link →</span>
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
