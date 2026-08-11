import { useState } from "react";

interface SparklinePoint {
  date: string; // YYYY-MM-DD
  value: number | null;
}

interface SparklineProps {
  points: SparklinePoint[];
  baseline?: number | null;
  color: string;
  width?: number;
  height?: number;
  formatValue?: (v: number) => string;
}

function formatAxisDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatHoverDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Single-series trend with a day-scaled x-axis and hover readout. Nulls leave gaps. */
export function Sparkline({
  points,
  baseline,
  color,
  width = 220,
  height = 72,
  formatValue,
}: SparklineProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const values = points.map((p) => p.value).filter((v): v is number => v != null);
  if (points.length === 0 || values.length === 0) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center text-xs text-ink-muted">
        No data yet
      </div>
    );
  }

  const padL = 4;
  const padR = 4;
  const padT = 14;
  const padB = 18; // room for date ticks
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const min = Math.min(...values, baseline ?? values[0]!);
  const max = Math.max(...values, baseline ?? values[0]!);
  const range = max - min || 1;

  const xAt = (i: number) =>
    points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
  const yAt = (v: number) => padT + (1 - (v - min) / range) * plotH;

  // Draw discontinuous segments so missing days don't invent a slope.
  const segments: string[] = [];
  let segment: string[] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (segment.length) {
        segments.push(segment.join(" "));
        segment = [];
      }
      return;
    }
    const cmd = segment.length === 0 ? "M" : "L";
    segment.push(`${cmd}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`);
  });
  if (segment.length) segments.push(segment.join(" "));

  const lastIdx = (() => {
    for (let i = points.length - 1; i >= 0; i--) if (points[i]!.value != null) return i;
    return -1;
  })();
  const baselineY = baseline != null ? yAt(baseline) : null;

  const activeIdx = hoverIndex ?? lastIdx;
  const active = activeIdx >= 0 ? points[activeIdx]! : null;
  const activeValue = active?.value ?? null;
  const activeX = activeIdx >= 0 ? xAt(activeIdx) : 0;
  const activeY = activeValue != null ? yAt(activeValue) : 0;

  const tickIndexes =
    points.length <= 2
      ? points.map((_, i) => i)
      : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  const label =
    active && activeValue != null
      ? `${formatHoverDate(active.date)} · ${formatValue ? formatValue(activeValue) : activeValue.toFixed(0)}`
      : "Trend";

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className="overflow-visible"
      onPointerLeave={() => setHoverIndex(null)}
    >
      {baselineY != null && (
        <line
          x1={padL}
          x2={width - padR}
          y1={baselineY}
          y2={baselineY}
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={1}
          strokeDasharray="3,3"
        />
      )}

      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {hoverIndex != null && activeValue != null && (
        <line
          x1={activeX}
          x2={activeX}
          y1={padT}
          y2={padT + plotH}
          stroke={color}
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      )}

      {points.map((p, i) => (
        <rect
          key={p.date}
          x={points.length === 1 ? padL : xAt(i) - plotW / points.length / 2}
          y={padT}
          width={points.length === 1 ? plotW : plotW / points.length}
          height={plotH}
          fill="transparent"
          className="cursor-crosshair"
          onPointerEnter={() => setHoverIndex(i)}
        />
      ))}

      {activeValue != null && (
        <circle
          cx={activeX}
          cy={activeY}
          r={hoverIndex != null ? 4 : 3.5}
          fill={color}
          stroke="#1B2320"
          strokeWidth={1.5}
        />
      )}

      {active && activeValue != null && (
        <g transform={`translate(${Math.min(Math.max(activeX, 36), width - 36)}, ${Math.max(10, activeY - 10)})`}>
          <text textAnchor="middle" fontSize={10} className="fill-ink-secondary font-mono">
            {hoverIndex != null
              ? `${formatAxisDate(active.date)} · ${formatValue ? formatValue(activeValue) : activeValue.toFixed(0)}`
              : formatValue
                ? formatValue(activeValue)
                : activeValue.toFixed(0)}
          </text>
        </g>
      )}

      {tickIndexes.map((i) => {
        const p = points[i]!;
        return (
          <text
            key={`tick-${p.date}`}
            x={xAt(i)}
            y={height - 2}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            fontSize={9}
            className="fill-ink-muted font-mono"
          >
            {formatAxisDate(p.date)}
          </text>
        );
      })}
    </svg>
  );
}
