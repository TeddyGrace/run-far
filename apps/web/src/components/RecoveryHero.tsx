import type { RecoverySnapshot } from "@run-far/shared";
import type { RecoveryHistoryEntry } from "../types.js";
import { zoneForRecovery, ZONE_LABEL, ZONE_HEX } from "../lib/zone.js";
import { Sparkline } from "./Sparkline.js";

interface RecoveryHeroProps {
  snapshot: RecoverySnapshot | null;
  history: RecoveryHistoryEntry[];
}

/** The dashboard's hero: today's recovery number sits inside an ambient wash tinted by
 * its own zone color — the app's one signature device, since that zone is the exact
 * state the recommendation engine keys off. */
export function RecoveryHero({ snapshot, history }: RecoveryHeroProps) {
  const zone = zoneForRecovery(snapshot?.recoveryScore ?? null);
  const hex = ZONE_HEX[zone];

  const hrvPoints = history.map((h) => ({ date: h.date, value: h.recovery?.hrvRmssdMs ?? null }));
  const rhrPoints = history.map((h) => ({ date: h.date, value: h.recovery?.restingHr ?? null }));

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
        <div className="flex gap-8">
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-ink-muted">HRV</p>
            <Sparkline
              points={hrvPoints}
              baseline={snapshot?.hrvBaselineMs ?? null}
              color={ZONE_HEX.info}
              width={160}
              height={48}
              formatValue={(v) => `${v.toFixed(0)}ms`}
            />
          </div>
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-ink-muted">Resting HR</p>
            <Sparkline
              points={rhrPoints}
              baseline={snapshot?.restingHrBaseline ?? null}
              color="#9FADA5"
              width={160}
              height={48}
              formatValue={(v) => `${v.toFixed(0)}bpm`}
            />
          </div>
        </div>
      </div>
      <div className="mt-6 flex gap-6 border-t border-border pt-4 text-sm text-ink-secondary">
        <Stat
          label="Sleep debt (7d)"
          value={snapshot?.sleepDebtMin7d != null ? `${(snapshot.sleepDebtMin7d / 60).toFixed(1)}h` : "—"}
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
