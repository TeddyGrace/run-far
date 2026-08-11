import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ImportPreview } from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";

export function Import() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [planName, setPlanName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const uploadPreview = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api.upload<ImportPreview>("/plans/import/preview", formData);
    },
    onSuccess: (data) => {
      setPreview(data);
      setPlanName(data.planName);
      setError(null);
      setResult(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't read that file"),
  });

  const commit = useMutation({
    mutationFn: () => api.post<{ planId: string; inserted: number; updated: number; skipped: number }>("/plans/import/commit", {
      uploadToken: preview!.uploadToken,
      planName,
    }),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't import that plan"),
  });

  function onFileSelected(file: File | null | undefined) {
    if (!file) return;
    uploadPreview.mutate(file);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 font-display text-xl font-semibold text-ink-primary">Import a training plan</h1>
      <p className="mb-6 text-sm text-ink-secondary">Upload a CSV export from TrainingPeaks to add runs to your calendar.</p>

      {!preview && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFileSelected(e.dataTransfer.files[0]);
          }}
          onClick={() => fileInput.current?.click()}
          className="cursor-pointer rounded-xl border-2 border-dashed border-border bg-surface-1 p-10 text-center transition-colors hover:border-accent/50"
        >
          <p className="text-ink-secondary">
            {uploadPreview.isPending ? "Reading file…" : "Drop a CSV file here, or click to choose one"}
          </p>
          <input
            ref={fileInput}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => onFileSelected(e.target.files?.[0])}
          />
        </div>
      )}

      {error && <p className="mt-4 text-sm text-zone-red">{error}</p>}

      {result && (
        <div className="mt-4 rounded-xl border border-border bg-surface-1 p-5">
          <p className="text-ink-primary">
            Imported {result.inserted} new run{result.inserted === 1 ? "" : "s"}
            {result.updated > 0 && `, updated ${result.updated}`}
            {result.skipped > 0 && `, skipped ${result.skipped} row${result.skipped === 1 ? "" : "s"} without a date`}.
          </p>
        </div>
      )}

      {preview && (
        <div className="mt-2 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-ink-secondary">Plan name</label>
            <input
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-ink-primary"
            />
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-ink-secondary">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Distance</th>
                  <th className="px-3 py-2 font-medium">Warnings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-surface-1">
                {preview.rows.map((row) => (
                  <tr key={row.rowIndex} className={row.scheduledAt == null ? "opacity-50" : undefined}>
                    <td className="px-3 py-2 font-mono text-ink-primary">
                      {row.scheduledAt ? new Date(row.scheduledAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2 capitalize text-ink-secondary">{row.runType ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-ink-secondary">
                      {row.durationMin != null ? `${row.durationMin}min` : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-ink-secondary">
                      {row.distanceM != null ? `${(row.distanceM / 1000).toFixed(1)}km` : "—"}
                    </td>
                    <td className="px-3 py-2 text-zone-yellow">
                      {row.warnings.map((w) => w.message).join("; ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => commit.mutate()}
              disabled={commit.isPending}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
            >
              {commit.isPending ? "Importing…" : `Import ${preview.rows.filter((r) => r.scheduledAt).length} runs`}
            </button>
            <button
              onClick={() => setPreview(null)}
              className="rounded-md border border-border px-4 py-2 text-sm text-ink-secondary hover:text-ink-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
