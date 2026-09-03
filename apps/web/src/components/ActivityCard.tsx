import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecentActivity, ZoneDurations } from "../types.js";
import { isRunSport, sportLabel } from "../lib/sports.js";
import { api, ApiError } from "../lib/api.js";
import { formatMiles, formatPacePerMile, metersToFeet, milesToMeters } from "../lib/units.js";

/** Strain runs 0–21; tint once it crosses into a genuinely hard effort. */
function strainTone(strain: number | null): string {
  if (strain == null) return "text-ink-muted";
  if (strain >= 14) return "text-zone-red";
  if (strain >= 10) return "text-zone-yellow";
  return "text-zone-good";
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** 42 → "42m", 75 → "1h 15m" */
function formatDuration(min: number): string {
  const total = Math.round(min);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function kjToCal(kj: number): number {
  return Math.round(kj * 0.239);
}

const ZONE_KEYS = [
  "zone_zero_milli",
  "zone_one_milli",
  "zone_two_milli",
  "zone_three_milli",
  "zone_four_milli",
  "zone_five_milli",
] as const;

const ZONE_COLORS = ["#3A4540", "#6C7A73", "#7C96B8", "#6FAE6B", "#D9A548", "#D1554B"];

const ZONE_NAMES = ["Very light", "Light", "Moderate", "Hard", "Very hard", "Max"];

/** 45s / 12m / 12m 30s / 1h 5m */
function formatZoneTime(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (totalMin < 60) return secs === 0 ? `${totalMin}m` : `${totalMin}m ${secs}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function ZoneBar({ zones }: { zones: ZoneDurations }) {
  const [active, setActive] = useState<number | null>(null);

  const values = ZONE_KEYS.map((k) => zones[k] ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const hardPct = ((values[3]! + values[4]! + values[5]!) / total) * 100;

  // Tooltip sits over the midpoint of the hovered segment, clamped so it can't
  // overflow the card on the first or last zone.
  let cursor = 0;
  const centers = values.map((ms) => {
    const center = cursor + ms / 2;
    cursor += ms;
    return (center / total) * 100;
  });

  return (
    <div className="mt-3 space-y-1.5">
      <div className="relative">
        {active != null && (
          <div
            role="tooltip"
            style={{ left: `${Math.min(Math.max(centers[active]!, 12), 88)}%` }}
            className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] text-ink-primary shadow-lg"
          >
            <span style={{ color: ZONE_COLORS[active] }}>Z{active}</span>{" "}
            <span className="text-ink-muted">{ZONE_NAMES[active]}</span>{" "}
            {formatZoneTime(values[active]!)}{" "}
            <span className="text-ink-muted">
              ({((values[active]! / total) * 100).toFixed(0)}%)
            </span>
          </div>
        )}

        <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2">
          {values.map((ms, i) =>
            ms > 0 ? (
              <div
                key={ZONE_KEYS[i]}
                style={{ width: `${(ms / total) * 100}%`, backgroundColor: ZONE_COLORS[i] }}
                className={
                  "transition-opacity " + (active != null && active !== i ? "opacity-40" : "opacity-100")
                }
              />
            ) : null,
          )}
        </div>

        {/* The bar itself is only 6px tall; this transparent layer gives it a usable
            hover and focus target without changing the visual weight. */}
        <div
          className="absolute -inset-y-2 inset-x-0 flex"
          onPointerLeave={() => setActive(null)}
        >
          {values.map((ms, i) =>
            ms > 0 ? (
              <button
                key={ZONE_KEYS[i]}
                type="button"
                aria-label={`Zone ${i}, ${ZONE_NAMES[i]}, ${formatZoneTime(ms)}`}
                style={{ width: `${(ms / total) * 100}%` }}
                className="cursor-default rounded-sm focus-visible:outline-none"
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            ) : null,
          )}
        </div>
      </div>
      <div className="flex justify-between font-mono text-[10px] text-ink-muted">
        <span>HR zones</span>
        <span>{hardPct.toFixed(0)}% Z3–5</span>
      </div>
    </div>
  );
}

type Metric = { label: string; value: string };

/** Surface every Whoop WorkoutScore field we have — omit only when null/empty. */
function metricsFor(activity: RecentActivity): Metric[] {
  const out: Metric[] = [];

  if (activity.durationMin != null && activity.durationMin > 0) {
    out.push({ label: "Duration", value: formatDuration(activity.durationMin) });
  }
  if (activity.distanceM != null && activity.distanceM > 0) {
    out.push({ label: "Distance", value: formatMiles(activity.distanceM) });
  }
  if (activity.durationMin != null && activity.distanceM != null && activity.distanceM > 0) {
    const pace = formatPacePerMile(activity.durationMin, activity.distanceM);
    if (pace) out.push({ label: "Pace", value: pace });
  }
  if (activity.altitudeGainM != null && Math.abs(activity.altitudeGainM) >= 1) {
    out.push({ label: "Elev ↑", value: `+${Math.round(metersToFeet(activity.altitudeGainM))} ft` });
  }
  if (activity.altitudeChangeM != null && Math.abs(activity.altitudeChangeM) >= 1) {
    const n = Math.round(metersToFeet(activity.altitudeChangeM));
    out.push({ label: "Elev Δ", value: `${n > 0 ? "+" : ""}${n} ft` });
  }
  if (activity.avgHr != null) {
    out.push({ label: "Avg HR", value: `${Math.round(activity.avgHr)} bpm` });
  }
  if (activity.maxHr != null) {
    out.push({ label: "Max HR", value: `${Math.round(activity.maxHr)} bpm` });
  }
  if (activity.kilojoules != null) {
    out.push({ label: "Energy", value: `${kjToCal(activity.kilojoules)} cal` });
  }
  if (activity.percentRecorded != null) {
    // Whoop's live API returns 0–1 despite docs claiming 0–100.
    const pct = activity.percentRecorded <= 1 ? activity.percentRecorded * 100 : activity.percentRecorded;
    out.push({ label: "Coverage", value: `${Math.round(pct)}%` });
  }

  return out;
}

/** Inline "no distance? add it" affordance for a run Whoop synced with no GPS/footpod data —
 * otherwise the workout silently contributes 0 to weekly mileage with no indication why. */
function AddDistance({ activityId }: { activityId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  const save = useMutation({
    mutationFn: (miles: number) =>
      api.patch(`/recovery/activities/${activityId}`, { distanceM: milesToMeters(miles) }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["recovery", "activities"] });
    },
  });

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-3 border-t border-border pt-3 text-xs font-medium text-accent hover:text-accent-strong"
      >
        + Add distance
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const miles = Number(value);
        if (Number.isFinite(miles) && miles > 0) save.mutate(miles);
      }}
      className="mt-3 flex items-center gap-2 border-t border-border pt-3"
    >
      <input
        autoFocus
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        placeholder="Miles"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={save.isPending}
        className="w-20 rounded-md border border-border bg-surface-0 px-2 py-1 text-xs text-ink-primary"
      />
      <button
        type="submit"
        disabled={save.isPending || !value.trim()}
        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
      >
        {save.isPending ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setValue("");
        }}
        disabled={save.isPending}
        className="text-xs text-ink-muted hover:text-ink-secondary"
      >
        Cancel
      </button>
      {save.isError && (
        <span className="text-xs text-zone-red">
          {save.error instanceof ApiError ? save.error.message : "Couldn't save that"}
        </span>
      )}
    </form>
  );
}

export function ActivityCard({ activity }: { activity: RecentActivity }) {
  const when = [formatDay(activity.date), activity.startedAt ? formatClock(activity.startedAt) : null]
    .filter(Boolean)
    .join(" · ");

  const metrics = metricsFor(activity);
  const missingDistance =
    isRunSport(activity.sport) && (activity.distanceM == null || activity.distanceM <= 0);

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4 transition-colors hover:border-accent/40">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display font-medium text-ink-primary">{sportLabel(activity.sport)}</span>
        <span className="font-mono text-[11px] text-ink-muted">{when}</span>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <span className={`font-display text-2xl font-semibold tabular-nums ${strainTone(activity.strain)}`}>
          {activity.strain != null ? activity.strain.toFixed(1) : "—"}
        </span>
        <span className="text-xs uppercase tracking-wide text-ink-muted">strain</span>
      </div>

      {metrics.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border pt-3 text-xs sm:grid-cols-3">
          {metrics.map((m) => (
            <div key={m.label} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wide text-ink-muted">{m.label}</dt>
              <dd className="truncate font-mono text-ink-secondary">{m.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {activity.zoneDurations && <ZoneBar zones={activity.zoneDurations} />}

      {missingDistance && <AddDistance activityId={activity.id} />}
    </div>
  );
}
