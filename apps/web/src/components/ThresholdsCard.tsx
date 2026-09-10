import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleThresholdSettings } from "@run-far/shared";

import { api, ApiError } from "../lib/api.js";

/**
 * How each tunable is presented. Ordered as an athlete would reason about them — the recovery
 * zones first, since they drive the two rules that actually change a session, then the signals
 * that lead them.
 *
 * `format` exists because the stored unit and the useful unit differ for the volume cut: it is a
 * fraction on the wire (0.2) and a percentage to a person (20%). Keeping the conversion here,
 * next to the label, keeps it out of the mutation.
 */
const FIELDS: Array<{
  key: string;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  toDisplay?: (v: number) => number;
  fromDisplay?: (v: number) => number;
  suffix?: string;
}> = [
  {
    key: "recoveryRedMax",
    label: "Red zone ceiling",
    help: "Recovery at or below this downgrades a hard session to easy.",
    min: 1,
    max: 98,
    step: 1,
    suffix: "%",
  },
  {
    key: "recoveryYellowMax",
    label: "Yellow zone ceiling",
    help: "Above red and at or below this, a hard session is trimmed rather than dropped.",
    min: 2,
    max: 99,
    step: 1,
    suffix: "%",
  },
  {
    key: "volumeReductionYellowPct",
    label: "Yellow-day volume cut",
    help: "How much of a hard session to trim on a yellow day.",
    min: 5,
    max: 75,
    step: 5,
    toDisplay: (v) => Math.round(v * 100),
    fromDisplay: (v) => v / 100,
    suffix: "%",
  },
  {
    key: "maxConsecutiveHardDays",
    label: "Hard days in a row",
    help: "How many straight quality days the plan may schedule before it gets flagged.",
    min: 1,
    max: 6,
    step: 1,
    suffix: " days",
  },
  {
    key: "hrvSuppressedSd",
    label: "HRV suppression",
    help: "How far below your rolling baseline counts as a suppressed day.",
    min: 0.25,
    max: 4,
    step: 0.25,
    suffix: " SD",
  },
  {
    key: "hrvMinConsecutiveDays",
    label: "Suppressed days before flagging",
    help: "A single low day is usually noise — this is how many in a row it takes.",
    min: 1,
    max: 14,
    step: 1,
    suffix: " days",
  },
  {
    key: "sleepDebtThresholdMin",
    label: "Sleep debt threshold",
    help: "Debt above this pushes a hard session out a day rather than cutting it.",
    min: 15,
    max: 600,
    step: 15,
    suffix: " min",
  },
  {
    key: "acwrSpikeThreshold",
    label: "Load ramp warning",
    help: "Acute:chronic load ratio above which you get a ramp-rate warning.",
    min: 1.05,
    max: 3,
    step: 0.05,
    suffix: "x",
  },
];

/**
 * The rules engine's calibration, per athlete.
 *
 * These were one global constant, which meant every athlete was reasoned about with someone
 * else's numbers — a red line that is right for one runner is far too conservative for another.
 * The card deliberately shows what each value *ships* as alongside what the athlete has set, so
 * "Default" is visible state rather than something you infer from not having touched it.
 */
export function ThresholdsCard() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery<RuleThresholdSettings>({
    queryKey: ["settings", "thresholds"],
    queryFn: () => api.get<RuleThresholdSettings>("/settings/thresholds"),
  });

  const save = useMutation({
    mutationFn: (thresholds: Record<string, number | null>) =>
      api.patch<RuleThresholdSettings>("/settings/thresholds", { thresholds }),
    onMutate: () => setError(null),
    onSuccess: (next) => {
      queryClient.setQueryData(["settings", "thresholds"], next);
      // The engine re-decides on the server when these change; drop the cards the old
      // calibration produced so the dashboard doesn't show a stale verdict.
      void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
    onError: (err) => {
      setError(
        err instanceof ApiError ? err.message : "Could not save that value. Please try again.",
      );
    },
  });

  const data = settings.data;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <h2 className="font-display text-base font-semibold text-ink-primary">
        Recommendation thresholds
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        What counts as a hard day for <em>you</em>. These drive the rules engine — the shipped
        values are a reasonable starting point, not a diagnosis.
      </p>

      {settings.isLoading && <p className="mt-4 text-sm text-ink-muted">Loading…</p>}

      {error && (
        <p className="mt-4 rounded-lg border border-zone-red/30 bg-surface-2 p-3 text-sm text-ink-secondary">
          {error}
        </p>
      )}

      {data && (
        <div className="mt-4 space-y-4">
          {FIELDS.map((field) => (
            <ThresholdSlider
              key={field.key}
              field={field}
              resolved={data.resolved[field.key] ?? 0}
              shippedDefault={data.defaults[field.key] ?? 0}
              overridden={data.overrides[field.key] != null}
              disabled={save.isPending}
              onCommit={(value) => save.mutate({ [field.key]: value })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One slider.
 *
 * Holds its own draft value while the athlete drags. A range input driven straight from server
 * state would refuse to move under the cursor — every frame would snap back to the last saved
 * number — and committing on every frame would be a round trip per pixel, each one re-running
 * the engine. So: local while dragging, one save on release.
 *
 * `draft` is keyed off the resolved value so a save landing (or a reset) pulls the thumb back
 * into line with what the server actually stored.
 */
function ThresholdSlider({
  field,
  resolved,
  shippedDefault,
  overridden,
  disabled,
  onCommit,
}: {
  field: (typeof FIELDS)[number];
  resolved: number;
  shippedDefault: number;
  overridden: boolean;
  disabled: boolean;
  onCommit: (value: number | null) => void;
}) {
  const toDisplay = field.toDisplay ?? ((v: number) => v);
  const fromDisplay = field.fromDisplay ?? ((v: number) => v);
  const serverValue = toDisplay(resolved);
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? serverValue;

  function commit() {
    if (draft == null || draft === serverValue) {
      setDraft(null);
      return;
    }
    onCommit(fromDisplay(draft));
    setDraft(null);
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`threshold-${field.key}`} className="text-sm font-medium text-ink-primary">
          {field.label}
        </label>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm text-ink-primary">
            {value}
            {field.suffix}
          </span>
          {overridden ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                onCommit(null);
              }}
              className="font-mono text-xs text-accent hover:underline disabled:opacity-50"
              title={`Back to the shipped default (${toDisplay(shippedDefault)}${field.suffix ?? ""})`}
            >
              reset
            </button>
          ) : (
            <span className="font-mono text-xs text-ink-muted">default</span>
          )}
        </div>
      </div>
      <input
        id={`threshold-${field.key}`}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.currentTarget.value))}
        // Every way a range input can finish a change: mouse, touch, and the arrow keys that
        // make it usable without a pointer at all.
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="mt-2 w-full accent-accent"
      />
      <p className="mt-1 text-xs text-ink-muted">{field.help}</p>
    </div>
  );
}
