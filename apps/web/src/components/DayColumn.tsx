import { useDroppable } from "@dnd-kit/core";
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
      className={
        "min-h-[140px] rounded-xl border p-2 transition-colors " +
        (isOver ? "border-accent bg-accent/5" : "border-border bg-surface-1")
      }
    >
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className={"text-xs font-medium uppercase tracking-wide " + (isToday ? "text-accent" : "text-ink-muted")}>
          {date.toLocaleDateString(undefined, { weekday: "short" })}
        </span>
        <span className="font-mono text-xs text-ink-muted">{date.getDate()}</span>
      </div>
      <div className="space-y-1.5">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} onClick={() => onSelectRun(run)} />
        ))}
      </div>
    </div>
  );
}
