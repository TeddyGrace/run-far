import { useState } from "react";
import type { PlannedRun, RunType } from "@run-far/shared";
import { RUN_TYPE_OPTIONS } from "../lib/runTypes.js";

interface RunEditModalProps {
  run: PlannedRun;
  onClose: () => void;
  onSave: (updates: Partial<PlannedRun>) => void;
  onDelete: () => void;
  saving: boolean;
}

export function RunEditModal({ run, onClose, onSave, onDelete, saving }: RunEditModalProps) {
  const [runType, setRunType] = useState<RunType>(run.runType);
  const [durationMin, setDurationMin] = useState(run.durationMin?.toString() ?? "");
  const [distanceKm, setDistanceKm] = useState(run.distanceM != null ? (run.distanceM / 1000).toString() : "");
  const [description, setDescription] = useState(run.description ?? "");

  function submit() {
    onSave({
      runType,
      durationMin: durationMin ? Number(durationMin) : null,
      distanceM: distanceKm ? Number(distanceKm) * 1000 : null,
      description: description || null,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-border bg-surface-1 p-6"
      >
        <h2 className="mb-4 font-display text-lg font-semibold text-ink-primary">Edit run</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-ink-secondary">Type</label>
            <select
              value={runType}
              onChange={(e) => setRunType(e.target.value as RunType)}
              className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-ink-primary"
            >
              {RUN_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-sm text-ink-secondary">Duration (min)</label>
              <input
                type="number"
                value={durationMin}
                onChange={(e) => setDurationMin(e.target.value)}
                className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-ink-primary"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block text-sm text-ink-secondary">Distance (km)</label>
              <input
                type="number"
                value={distanceKm}
                onChange={(e) => setDistanceKm(e.target.value)}
                className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-ink-primary"
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-ink-secondary">Notes</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-ink-primary"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-between">
          <button
            onClick={onDelete}
            disabled={saving}
            className="text-sm text-zone-red transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            Delete run
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
