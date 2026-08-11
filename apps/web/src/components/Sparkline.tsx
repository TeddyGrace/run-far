interface SparklinePoint {
  date: string;
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

/** A single-series trend line: thin 2px stroke, rounded data-ends, a dashed baseline
 * reference, and a highlighted final point with its value labeled directly (no legend
 * needed for one series). */
export function Sparkline({ points, baseline, color, width = 220, height = 56, formatValue }: SparklineProps) {
  const values = points.map((p) => p.value).filter((v): v is number => v != null);
  if (values.length === 0) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center text-xs text-ink-muted">
        No data yet
      </div>
    );
  }

  const padding = 8;
  const min = Math.min(...values, baseline ?? values[0]!);
  const max = Math.max(...values, baseline ?? values[0]!);
  const range = max - min || 1;

  const usable = points.filter((p) => p.value != null) as { date: string; value: number }[];
  const xStep = usable.length > 1 ? (width - padding * 2) / (usable.length - 1) : 0;
  const toXY = (i: number, v: number) => {
    const x = padding + i * xStep;
    const y = padding + (1 - (v - min) / range) * (height - padding * 2);
    return [x, y] as const;
  };

  const path = usable
    .map((p, i) => {
      const [x, y] = toXY(i, p.value);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = usable[usable.length - 1]!;
  const [lastX, lastY] = toXY(usable.length - 1, last.value);
  const baselineY = baseline != null ? padding + (1 - (baseline - min) / range) * (height - padding * 2) : null;

  return (
    <svg width={width} height={height} role="img" aria-label={`Trend, latest value ${formatValue ? formatValue(last.value) : last.value}`}>
      {baselineY != null && (
        <line
          x1={padding}
          x2={width - padding}
          y1={baselineY}
          y2={baselineY}
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={1}
          strokeDasharray="3,3"
        />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={3.5} fill={color} stroke="var(--sparkline-surface, #1B2320)" strokeWidth={1.5} />
      <text x={lastX} y={Math.max(10, lastY - 8)} textAnchor="end" fontSize={11} className="fill-ink-secondary font-mono">
        {formatValue ? formatValue(last.value) : last.value.toFixed(0)}
      </text>
    </svg>
  );
}
