import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import type { RecentActivitiesResponse } from "../types.js";
import { activityFilterChips, expandSportFilters, sportLabel } from "../lib/sports.js";
import { ActivityCard } from "./ActivityCard.js";

const PAGE_SIZE = 6;

export function RecentActivities() {
  const [sportsFilter, setSportsFilter] = useState<string[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const activities = useQuery<RecentActivitiesResponse>({
    queryKey: ["recovery", "activities", sportsFilter, limit],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit), offset: "0" });
      const expanded = expandSportFilters(sportsFilter);
      if (expanded.length > 0) params.set("sport", expanded.join(","));
      return api.get<RecentActivitiesResponse>(`/recovery/activities?${params}`);
    },
    // Keep the current list on screen while the next page loads so the viewport
    // doesn't jump to the top when the grid briefly unmounts.
    placeholderData: keepPreviousData,
  });

  const data = activities.data;
  const sports = activityFilterChips(data?.sports ?? []);
  const initialLoad = activities.isLoading && !activities.isPlaceholderData;
  const filtering = sportsFilter.length > 0;

  function clearFilters() {
    setSportsFilter([]);
    setLimit(PAGE_SIZE);
  }

  function toggleSport(s: string) {
    setSportsFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setLimit(PAGE_SIZE);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
          Recent activities
        </h2>
        {data && data.total > 0 && (
          <p className="font-mono text-xs text-ink-muted">
            {data.items.length} of {data.total}
          </p>
        )}
      </div>

      {sports.length > 0 && (
        <div
          className="mb-4 flex flex-wrap gap-2"
          role="group"
          aria-label="Filter by activity type"
        >
          <FilterChip active={!filtering} onClick={clearFilters}>
            Recent
          </FilterChip>
          {sports.map((s) => (
            <FilterChip
              key={s}
              active={sportsFilter.includes(s)}
              onClick={() => toggleSport(s)}
            >
              {sportLabel(s)}
            </FilterChip>
          ))}
        </div>
      )}

      {initialLoad && <p className="text-sm text-ink-muted">Loading activities…</p>}

      {!initialLoad && data?.items.length === 0 && (
        <p className="rounded-xl border border-border bg-surface-1 p-4 text-sm text-ink-secondary">
          {filtering
            ? `No ${sportsFilter.map(sportLabel).join(" / ").toLowerCase()} workouts synced yet.`
            : "No workouts synced yet. Connect Whoop in Settings, then run a sync."}
        </p>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} />
            ))}
          </div>
          {data.hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={activities.isFetching}
                onClick={() => setLimit((n) => n + PAGE_SIZE)}
                className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary transition-colors hover:border-accent/50 hover:text-ink-primary disabled:opacity-50"
              >
                {activities.isFetching ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
        (active
          ? "bg-accent/15 text-accent-strong"
          : "bg-surface-1 text-ink-muted hover:bg-surface-2 hover:text-ink-secondary")
      }
    >
      {children}
    </button>
  );
}
