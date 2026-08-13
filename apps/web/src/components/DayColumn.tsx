import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import type { PlannedRun, WeatherForecast } from "@run-far/shared";
import { RunCard } from "./RunCard.js";
import { WeatherReadout } from "./WeatherReadout.js";
import { SEGMENT_LABELS } from "../lib/weather.js";

interface DayColumnProps {
  date: Date;
  runs: PlannedRun[];
  forecast?: WeatherForecast;
  onSelectRun: (run: PlannedRun) => void;
}

export function DayColumn({ date, runs, forecast, onSelectRun }: DayColumnProps) {
  const [expanded, setExpanded] = useState(true);
  const dayKey = date.toISOString().slice(0, 10);
  const { setNodeRef, isOver } = useDroppable({ id: dayKey });
  const isToday = dayKey === new Date().toISOString().slice(0, 10);

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        "flex min-h-[260px] flex-col rounded-xl border p-3 transition-colors",
        isOver
          ? "border-accent bg-accent/5"
          : isToday
            ? "border-accent bg-accent/[0.06] ring-1 ring-accent/30"
            : "border-border bg-surface-1",
      )}
    >
      <div className="mb-3 flex items-baseline justify-between border-b border-border pb-2">
        <span
          className={clsx(
            "flex items-center gap-1.5 text-sm font-medium uppercase tracking-wide",
            isToday ? "text-accent" : "text-ink-secondary",
          )}
        >
          {date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}
          {isToday && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-surface-0">
              Today
            </span>
          )}
        </span>
        <span
          className={clsx(
            "font-mono text-lg leading-none",
            isToday ? "text-accent" : "text-ink-muted",
          )}
        >
          {date.getUTCDate()}
        </span>
      </div>
      {forecast && (
        <div className="mb-2 text-xs text-ink-secondary">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={forecast.shortForecast ?? undefined}
            className="flex w-full items-center gap-1 rounded hover:text-ink-primary"
          >
            <WeatherReadout
              iconCode={forecast.iconCode}
              tempF={forecast.highTempF}
              lowTempF={forecast.lowTempF}
              precipPct={forecast.precipProbabilityPct}
              iconSize="h-6 w-6"
            />
            {forecast.alerts.length > 0 && (
              <span className="text-red-500" title={forecast.alerts.map((a) => a.event).join(", ")}>
                ⚠
              </span>
            )}
            {forecast.segments.length > 0 && (
              <svg
                viewBox="0 0 24 24"
                className={clsx("ml-auto h-3 w-3 shrink-0 text-ink-muted transition-transform", expanded && "rotate-180")}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            )}
          </button>
          {expanded && forecast.segments.length > 0 && (
            <div className="mt-1.5 space-y-1 rounded-md border border-border bg-surface-2 p-1.5">
              {forecast.segments.map((s) => (
                <div key={s.segment} className="flex items-center justify-between gap-1">
                  <span className="w-11 shrink-0 text-[10px] uppercase tracking-wide text-ink-muted">
                    {SEGMENT_LABELS[s.segment]}
                  </span>
                  <WeatherReadout
                    iconCode={s.iconCode}
                    isDaytime={s.isDaytime}
                    tempF={s.tempF}
                    precipPct={s.precipPct}
                    iconSize="h-4 w-4"
                    gapClassName="gap-1"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex-1 space-y-2">
        {runs.length === 0 ? (
          <p className="text-sm text-ink-muted/60">Rest</p>
        ) : (
          runs.map((run) => <RunCard key={run.id} run={run} onClick={() => onSelectRun(run)} />)
        )}
      </div>
    </div>
  );
}
