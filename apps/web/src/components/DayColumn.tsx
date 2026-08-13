import { useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import type { PlannedRun, WeatherForecast } from "@run-far/shared";
import { RunCard } from "./RunCard.js";

interface DayColumnProps {
  date: Date;
  runs: PlannedRun[];
  forecast?: WeatherForecast;
  onSelectRun: (run: PlannedRun) => void;
}

export function DayColumn({ date, runs, forecast, onSelectRun }: DayColumnProps) {
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
        <div
          className="mb-2 flex items-center gap-1 text-xs text-ink-secondary"
          title={forecast.shortForecast ?? undefined}
        >
          {forecast.iconUrl && <img src={forecast.iconUrl} alt="" className="h-6 w-6" />}
          {forecast.highTempF != null && <span>{Math.round(forecast.highTempF)}°</span>}
          {forecast.lowTempF != null && <span className="text-ink-muted">/{Math.round(forecast.lowTempF)}°</span>}
          {forecast.alerts.length > 0 && (
            <span className="text-red-500" title={forecast.alerts.map((a) => a.event).join(", ")}>
              ⚠
            </span>
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
