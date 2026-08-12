import type { RecoverySnapshot } from "@run-far/shared";
import type { RecoveryHistoryEntry } from "../types.js";
import { zoneForRecovery, ZONE_LABEL, ZONE_HEX } from "../lib/zone.js";
import { Sparkline } from "./Sparkline.js";
import { formatMiles } from "../lib/units.js";

interface RecoveryHeroProps {
  snapshot: RecoverySnapshot | null;
  history: RecoveryHistoryEntry[];
}

const HISTORY_DAYS = 14;

/** Fill a contiguous UTC day window so the sparkline x-axis is a real timescale. */
function dailySeries(
  history: RecoveryHistoryEntry[],
  pick: (entry: RecoveryHistoryEntry | undefined) => number | null,
  days = HISTORY_DAYS,
): { date: string; value: number | null }[] {
  const byDate = new Map(history.map((h) => [h.date, h]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (days - 1 - i));
    const iso = d.toISOString().slice(0, 10);
    return { date: iso, value: pick(byDate.get(iso)) };
  });
}

function Trend({
  label,
  points,
  baseline,
  color,
  formatValue,
  min,
  max,
}: {
  label: string;
  points: { date: string; value: number | null }[];
  baseline?: number | null;
  color: string;
  formatValue: (v: number) => string;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <Sparkline
        points={points}
        baseline={baseline}
        color={color}
        width={200}
        height={72}
        formatValue={formatValue}
        min={min}
        max={max}
      />
    </div>
  );
}

/** The dashboard's hero: today's recovery number sits inside an ambient wash tinted by
 * its own zone color — the app's one signature device, since that zone is the exact
 * state the recommendation engine keys off. */
export function RecoveryHero({ snapshot, history }: RecoveryHeroProps) {
  const zone = zoneForRecovery(snapshot?.recoveryScore ?? null);
  const hex = ZONE_HEX[zone];

  const hrvPoints = dailySeries(history, (h) => h?.recovery?.hrvRmssdMs ?? null);
  const rhrPoints = dailySeries(history, (h) => h?.recovery?.restingHr ?? null);
  const strainPoints = dailySeries(history, (h) => h?.strain ?? null);
  const sleepPoints = dailySeries(history, (h) => h?.sleep?.performancePct ?? null);

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-border p-8"
      style={{
        background: `radial-gradient(circle at 15% 20%, ${hex}26, transparent 55%), #1B2320`,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-8">
        <div>
          <p className="mb-2 text-sm font-medium uppercase tracking-wide text-ink-secondary">
            Today's recovery
          </p>
          <div className="flex items-baseline gap-3">
            <span className="font-display text-6xl font-semibold tabular-nums text-ink-primary">
              {snapshot?.recoveryScore != null ? Math.round(snapshot.recoveryScore) : "—"}
            </span>
            <span className="font-medium" style={{ color: hex }}>
              {ZONE_LABEL[zone]}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <Trend
            label="HRV · 14d"
            points={hrvPoints}
            baseline={snapshot?.hrvBaselineMs ?? null}
            color={ZONE_HEX.info}
            formatValue={(v) => `${v.toFixed(0)}ms`}
          />
          <Trend
            label="Resting HR · 14d"
            points={rhrPoints}
            baseline={snapshot?.restingHrBaseline ?? null}
            color="#9FADA5"
            formatValue={(v) => `${v.toFixed(0)}bpm`}
          />
          <Trend
            label="Strain · 14d"
            points={strainPoints}
            color={ZONE_HEX.yellow}
            formatValue={(v) => v.toFixed(1)}
          />
          <Trend
            label="Sleep score · 14d"
            points={sleepPoints}
            color={ZONE_HEX.good}
            formatValue={(v) => `${v.toFixed(0)}%`}
            min={0}
            max={100}
          />
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-6 border-t border-border pt-4 text-sm text-ink-secondary">
        <Stat
          label="Mileage (week)"
          value={
            snapshot?.runDistanceMThisWeek != null
              ? formatMiles(snapshot.runDistanceMThisWeek, 1)
              : "—"
          }
        />
        <Stat
          label="Avg / week (month)"
          value={
            snapshot?.runDistanceMPerWeekThisMonth != null
              ? `${formatMiles(snapshot.runDistanceMPerWeekThisMonth, 1)}/wk`
              : "—"
          }
        />
        <Stat label="Strain (7d)" value={snapshot?.strain7d != null ? snapshot.strain7d.toFixed(1) : "—"} />
        <Stat label="ACWR" value={snapshot?.acwr != null ? snapshot.acwr.toFixed(2) : "—"} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-ink-muted">{label}</span>{" "}
      <span className="font-mono text-ink-primary">{value}</span>
    </div>
  );
}
