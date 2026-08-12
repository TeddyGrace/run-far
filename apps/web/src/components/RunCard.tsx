import { useDraggable } from "@dnd-kit/core";
import type { PlannedRun } from "@run-far/shared";
import { HARD_RUN_TYPES } from "../lib/runTypes.js";
import { formatMiles } from "../lib/units.js";

export function RunCard({ run, onClick }: { run: PlannedRun; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: run.id });
  const hard = HARD_RUN_TYPES.has(run.runType);
  const time = new Date(run.scheduledAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        opacity: isDragging ? 0.4 : 1,
      }}
      className={
        "w-full rounded-lg border px-3 py-2.5 text-left transition-colors " +
        (hard
          ? "border-accent/40 bg-accent/10 text-ink-primary hover:bg-accent/15"
          : "border-border bg-surface-2 text-ink-secondary hover:bg-surface-2/70")
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base font-medium capitalize text-ink-primary">{run.runType}</span>
        <span className="font-mono text-xs text-ink-muted">{time}</span>
      </div>
      {(run.durationMin != null || run.distanceM != null) && (
        <div className="mt-1 flex gap-3 font-mono text-sm text-ink-secondary">
          {run.durationMin != null && <span>{run.durationMin}min</span>}
          {run.distanceM != null && <span>{formatMiles(run.distanceM, 1)}</span>}
        </div>
      )}
      {run.description && (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-snug text-ink-muted">{run.description}</p>
      )}
    </button>
  );
}
