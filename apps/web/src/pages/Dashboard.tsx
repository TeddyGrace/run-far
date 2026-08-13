import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import type { PlannedRun, Recommendation, RecoverySnapshot } from "@run-far/shared";
import { api } from "../lib/api.js";
import type { RecoveryHistoryEntry } from "../types.js";
import { RecoveryHero } from "../components/RecoveryHero.js";
import { RecommendationCard } from "../components/RecommendationCard.js";
import { RecentActivities } from "../components/RecentActivities.js";
import { WeatherToday } from "../components/WeatherToday.js";
import { HARD_RUN_TYPES } from "../lib/runTypes.js";
import { formatMiles } from "../lib/units.js";

// Snapped to UTC midnight so the value is identical across renders — a timestamp that
// moves every render would change the query key and refetch in a loop.
function todayRange() {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 8);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const { from, to } = todayRange();

  const history = useQuery<RecoveryHistoryEntry[]>({
    queryKey: ["recovery", "history"],
    queryFn: () => api.get<RecoveryHistoryEntry[]>("/recovery/history?days=14"),
  });

  const snapshot = useQuery<RecoverySnapshot>({
    queryKey: ["recovery", "today"],
    queryFn: () => api.get<RecoverySnapshot>("/recovery/today"),
  });

  const recommendations = useQuery<Recommendation[]>({
    queryKey: ["recommendations"],
    queryFn: () => api.get<Recommendation[]>("/recommendations"),
  });

  const runs = useQuery<PlannedRun[]>({
    queryKey: ["runs", from, to],
    queryFn: () => api.get<PlannedRun[]>(`/runs?from=${from}&to=${to}`),
  });

  const respond = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "dismiss" }) =>
      api.post(`/recommendations/${id}/${action}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const [primary, ...secondary] = recommendations.data ?? [];

  return (
    <div className="space-y-6">
      <RecoveryHero snapshot={snapshot.data ?? null} history={history.data ?? []} />

      <WeatherToday />

      <div>
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
          Today's recommendation
        </h2>
        {recommendations.isLoading && <p className="text-sm text-ink-muted">Checking recovery against your plan…</p>}
        {!recommendations.isLoading && !primary && (
          <p className="rounded-xl border border-border bg-surface-1 p-5 text-sm text-ink-secondary">
            Nothing to flag right now — the plan looks fine as scheduled.
          </p>
        )}
        {primary && (
          <RecommendationCard
            recommendation={primary}
            primary
            onAccept={(id) => respond.mutate({ id, action: "accept" })}
            onDismiss={(id) => respond.mutate({ id, action: "dismiss" })}
            pending={respond.isPending}
          />
        )}
        {secondary.length > 0 && (
          <div className="mt-3 space-y-2">
            {secondary.map((r) => (
              <RecommendationCard
                key={r.id}
                recommendation={r}
                primary={false}
                onAccept={(id) => respond.mutate({ id, action: "accept" })}
                onDismiss={(id) => respond.mutate({ id, action: "dismiss" })}
                pending={respond.isPending}
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
          This week
        </h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-surface-1">
          {runs.isLoading && <p className="p-4 text-sm text-ink-muted">Loading runs…</p>}
          {!runs.isLoading && runs.data?.length === 0 && (
            <p className="p-4 text-sm text-ink-muted">No runs scheduled — build a plan or add one manually.</p>
          )}
          {runs.data?.map((run) => {
            const hard = HARD_RUN_TYPES.has(run.runType);
            const date = new Date(run.scheduledAt);
            return (
              <div key={run.id} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <span className="w-16 font-mono text-xs text-ink-muted">
                    {date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
                  </span>
                  <span className={hard ? "font-medium text-ink-primary" : "text-ink-secondary"}>
                    {run.runType}
                  </span>
                </div>
                <div className="flex gap-4 text-sm text-ink-muted">
                  {run.durationMin != null && <span className="font-mono">{run.durationMin}min</span>}
                  {run.distanceM != null && (
                    <span className="font-mono">{formatMiles(run.distanceM, 1)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <RecentActivities />
    </div>
  );
}
