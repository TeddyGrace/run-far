import { useDraggable } from "@dnd-kit/core";
import type { PlannedRun } from "@run-far/shared";
import { HARD_RUN_TYPES } from "../lib/runTypes.js";

export function RunCard({ run, onClick }: { run: PlannedRun; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: run.id });
  const hard = HARD_RUN_TYPES.has(run.runType);

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
        "w-full rounded-lg border px-2.5 py-2 text-left text-sm transition-colors " +
        (hard
          ? "border-accent/40 bg-accent/10 text-ink-primary hover:bg-accent/15"
          : "border-border bg-surface-2 text-ink-secondary hover:bg-surface-2/70")
      }
    >
      <div className="font-medium capitalize">{run.runType}</div>
      <div className="mt-0.5 flex gap-2 font-mono text-xs text-ink-muted">
        {run.durationMin != null && <span>{run.durationMin}min</span>}
        {run.distanceM != null && <span>{(run.distanceM / 1000).toFixed(1)}km</span>}
      </div>
    </button>
  );
}
