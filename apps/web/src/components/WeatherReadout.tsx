import clsx from "clsx";
import type { WeatherIconCode } from "@run-far/shared";
import { WeatherIcon } from "./WeatherIcon.js";

interface WeatherReadoutProps {
  iconCode: WeatherIconCode | null;
  isDaytime?: boolean;
  tempF?: number | null;
  lowTempF?: number | null;
  precipPct?: number | null;
  iconSize?: string;
  /** Stack icon/temp/precip vertically instead of in a row — used for the segment tiles. */
  stacked?: boolean;
  gapClassName?: string;
  className?: string;
}

const PRECIP_NOTABLE_PCT = 30;

/** Icon + temp + precip-chance chip, shared by the calendar cell and the dashboard's
 * today card so both surfaces read identically. */
export function WeatherReadout({
  iconCode,
  isDaytime = true,
  tempF,
  lowTempF,
  precipPct,
  iconSize = "h-6 w-6",
  stacked = false,
  gapClassName = "gap-1.5",
  className,
}: WeatherReadoutProps) {
  return (
    <div className={clsx("flex items-center", stacked ? "flex-col" : "flex-row", gapClassName, className)}>
      <WeatherIcon code={iconCode} isDaytime={isDaytime} className={iconSize} />
      {tempF != null && <span>{Math.round(tempF)}°</span>}
      {lowTempF != null && <span className="text-ink-muted">/{Math.round(lowTempF)}°</span>}
      {precipPct != null && precipPct > 0 && (
        <span
          className={clsx(
            "flex items-center gap-0.5",
            precipPct >= PRECIP_NOTABLE_PCT ? "text-accent" : "text-ink-muted",
          )}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
            <path d="M12 2.5c2.8 4 6.2 8.3 6.2 12a6.2 6.2 0 11-12.4 0c0-3.7 3.4-8 6.2-12z" />
          </svg>
          {Math.round(precipPct)}%
        </span>
      )}
    </div>
  );
}
