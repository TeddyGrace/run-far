import { useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import type { PlannedRun } from "@run-far/shared";
import { RunCard } from "./RunCard.js";

interface DayColumnProps {
  date: Date;
  runs: PlannedRun[];
  onSelectRun: (run: PlannedRun) => void;
}

export function DayColumn({ date, runs, onSelectRun }: DayColumnProps) {
  const dayKey = date.toISOString().slice(0, 10);
  const { setNodeRef, isOver } = useDroppable({ id: dayKey });
  const isToday = dayKey === new Date().toISOString().slice(0, 10);

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        "flex min-h-[260px] flex-col rounded-xl border p-3 transition-colors",
        isOver ? "border-accent bg-accent/5" : "border-border bg-surface-1",
        isToday && !isOver && "border-accent/40",
      )}
    >
      <div className="mb-3 flex items-baseline justify-between border-b border-border pb-2">
        <span
          className={clsx(
            "text-sm font-medium uppercase tracking-wide",
            isToday ? "text-accent" : "text-ink-secondary",
          )}
        >
          {date.toLocaleDateString(undefined, { weekday: "short" })}
        </span>
        <span
          className={clsx(
            "font-mono text-lg leading-none",
            isToday ? "text-accent" : "text-ink-muted",
          )}
        >
          {date.getDate()}
        </span>
      </div>
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
