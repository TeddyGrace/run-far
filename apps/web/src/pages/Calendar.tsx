import { useMemo, useState } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { PlannedRun, WeatherForecast, WeatherForecastResponse } from "@run-far/shared";
import { api } from "../lib/api.js";
import { DayColumn } from "../components/DayColumn.js";
import { RunEditModal } from "../components/RunEditModal.js";

function startOfWeek(offsetWeeks: number): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7) + offsetWeeks * 7);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

export function Calendar() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedRun, setSelectedRun] = useState<PlannedRun | null>(null);
  const queryClient = useQueryClient();

  const weekStart = startOfWeek(weekOffset);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000)),
    [weekStart],
  );

  const runsQuery = useQuery<PlannedRun[]>({
    queryKey: ["runs", weekStart.toISOString(), weekEnd.toISOString()],
    queryFn: () => api.get<PlannedRun[]>(`/runs?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`),
  });

  const weatherQuery = useQuery<WeatherForecastResponse>({
    queryKey: ["weather", weekStart.toISOString(), weekEnd.toISOString()],
    queryFn: () =>
      api.get<WeatherForecastResponse>(
        `/weather/forecast?from=${weekStart.toISOString().slice(0, 10)}&to=${weekEnd.toISOString().slice(0, 10)}`,
      ),
  });

  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: ["runs"] });

  const updateRun = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<PlannedRun> }) =>
      api.patch<PlannedRun>(`/runs/${id}`, updates),
    onSuccess: () => {
      invalidateRuns();
      setSelectedRun(null);
    },
  });

  const deleteRun = useMutation({
    mutationFn: (id: string) => api.delete(`/runs/${id}`),
    onSuccess: () => {
      invalidateRuns();
      setSelectedRun(null);
    },
  });

  function runsForDay(day: Date): PlannedRun[] {
    const key = day.toISOString().slice(0, 10);
    return (runsQuery.data ?? []).filter((r) => r.scheduledAt.slice(0, 10) === key);
  }

  function forecastForDay(day: Date): WeatherForecast | undefined {
    const key = day.toISOString().slice(0, 10);
    return (weatherQuery.data?.forecasts ?? []).find((f) => f.date === key);
  }

  function onDragEnd(event: DragEndEvent) {
    const runId = event.active.id as string;
    const targetDayKey = event.over?.id as string | undefined;
    if (!targetDayKey) return;

    const run = runsQuery.data?.find((r) => r.id === runId);
    if (!run) return;
    if (run.scheduledAt.slice(0, 10) === targetDayKey) return;

    const original = new Date(run.scheduledAt);
    const [y, m, d] = targetDayKey.split("-").map(Number);
    const updated = new Date(original);
    updated.setUTCFullYear(y!, m! - 1, d!);
    updateRun.mutate({ id: runId, updates: { scheduledAt: updated.toISOString() } });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-ink-primary">
          {weekStart.toLocaleDateString(undefined, { month: "long", day: "numeric" })} –{" "}
          {days[6]!.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => setWeekOffset((w) => w - 1)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary"
          >
            Prev
          </button>
          <button
            onClick={() => setWeekOffset(0)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary"
          >
            This week
          </button>
          <button
            onClick={() => setWeekOffset((w) => w + 1)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary"
          >
            Next
          </button>
        </div>
      </div>

      {weatherQuery.data?.configured === false && (
        <p className="mb-4 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-secondary">
          Set your location in{" "}
          <Link to="/settings" className="text-accent hover:underline">
            Settings
          </Link>{" "}
          to see weather on your calendar.
        </p>
      )}

      <DndContext onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 xl:min-h-[calc(100vh-14rem)]">
          {days.map((day) => (
            <DayColumn
              key={day.toISOString()}
              date={day}
              runs={runsForDay(day)}
              forecast={forecastForDay(day)}
              onSelectRun={setSelectedRun}
            />
          ))}
        </div>
      </DndContext>

      {selectedRun && (
        <RunEditModal
          run={selectedRun}
          onClose={() => setSelectedRun(null)}
          onSave={(updates) => updateRun.mutate({ id: selectedRun.id, updates })}
          onDelete={() => deleteRun.mutate(selectedRun.id)}
          saving={updateRun.isPending || deleteRun.isPending}
        />
      )}
    </div>
  );
}
