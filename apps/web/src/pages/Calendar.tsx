import { useMemo, useState } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { PlannedRun, WeatherForecast, WeatherForecastResponse } from "@run-far/shared";
import { api } from "../lib/api.js";
import { DayColumn } from "../components/DayColumn.js";
import { RunEditModal } from "../components/RunEditModal.js";
import { addDaysYmd, localWeekDays, toLocalYmd, withLocalYmd, ymdToLocalDate } from "../lib/localDate.js";

export function Calendar() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedRun, setSelectedRun] = useState<PlannedRun | null>(null);
  const queryClient = useQueryClient();

  // Day columns are calendar dates in the athlete's own timezone, never UTC slices: at 9pm in
  // a negative-offset zone the UTC date is already tomorrow, which used to shift the whole
  // week (and the "Today" marker) forward by a day. The run/weather queries convert back to
  // instants only at the window edges.
  const days = useMemo(() => localWeekDays(weekOffset), [weekOffset]);
  const weekStartYmd = days[0]!;
  const weekEndYmd = days[6]!;
  const rangeFrom = useMemo(() => ymdToLocalDate(weekStartYmd).toISOString(), [weekStartYmd]);
  // End of the last local day, so a Sunday-evening run is inside the window.
  const rangeTo = useMemo(
    () => new Date(ymdToLocalDate(addDaysYmd(weekEndYmd, 1)).getTime() - 1).toISOString(),
    [weekEndYmd],
  );

  const runsQuery = useQuery<PlannedRun[]>({
    queryKey: ["runs", rangeFrom, rangeTo],
    queryFn: () => api.get<PlannedRun[]>(`/runs?from=${rangeFrom}&to=${rangeTo}`),
  });

  const weatherQuery = useQuery<WeatherForecastResponse>({
    queryKey: ["weather", weekStartYmd, weekEndYmd],
    queryFn: () =>
      api.get<WeatherForecastResponse>(`/weather/forecast?from=${weekStartYmd}&to=${weekEndYmd}`),
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

  // A run's stored scheduledAt is a UTC instant; bucket it by the local day it falls on
  // rather than by the ISO string's prefix, so a 9pm run stays on the evening it belongs to.
  function runsForDay(dayYmd: string): PlannedRun[] {
    return (runsQuery.data ?? []).filter((r) => toLocalYmd(new Date(r.scheduledAt)) === dayYmd);
  }

  // Forecast dates are already the athlete's local calendar dates (the API buckets them in
  // users.timezone), so these keys line up directly.
  function forecastForDay(dayYmd: string): WeatherForecast | undefined {
    return (weatherQuery.data?.forecasts ?? []).find((f) => f.date === dayYmd);
  }

  function onDragEnd(event: DragEndEvent) {
    const runId = event.active.id as string;
    const targetDayKey = event.over?.id as string | undefined;
    if (!targetDayKey) return;

    const run = runsQuery.data?.find((r) => r.id === runId);
    if (!run) return;
    const original = new Date(run.scheduledAt);
    if (toLocalYmd(original) === targetDayKey) return;

    const updated = withLocalYmd(original, targetDayKey);
    updateRun.mutate({ id: runId, updates: { scheduledAt: updated.toISOString() } });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-ink-primary">
          {ymdToLocalDate(weekStartYmd).toLocaleDateString(undefined, { month: "long", day: "numeric" })} –{" "}
          {ymdToLocalDate(weekEndYmd).toLocaleDateString(undefined, { month: "long", day: "numeric" })}
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
              key={day}
              dayYmd={day}
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
