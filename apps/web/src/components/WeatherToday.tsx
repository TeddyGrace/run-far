import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { WeatherForecastResponse } from "@run-far/shared";
import { api } from "../lib/api.js";
import { SEGMENT_LABELS } from "../lib/weather.js";
import { WeatherReadout } from "./WeatherReadout.js";

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export function WeatherToday() {
  const today = todayYmd();
  const weatherQuery = useQuery<WeatherForecastResponse>({
    queryKey: ["weather", today, today],
    queryFn: () => api.get<WeatherForecastResponse>(`/weather/forecast?from=${today}&to=${today}`),
  });

  if (weatherQuery.isLoading) return null;

  if (weatherQuery.data?.configured === false) {
    return (
      <p className="rounded-xl border border-border bg-surface-1 p-4 text-sm text-ink-secondary">
        Set your location in{" "}
        <Link to="/settings" className="text-accent hover:underline">
          Settings
        </Link>{" "}
        to see today's weather.
      </p>
    );
  }

  const forecast = weatherQuery.data?.forecasts[0];
  if (!forecast) return null;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4" title={forecast.shortForecast ?? undefined}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
          Today's weather
        </h2>
        {forecast.alerts.length > 0 && (
          <span
            className="flex items-center gap-1 text-xs font-medium text-red-500"
            title={forecast.alerts.map((a) => a.event).join(", ")}
          >
            ⚠ {forecast.alerts[0]!.event}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between">
        <WeatherReadout
          iconCode={forecast.iconCode}
          tempF={forecast.highTempF}
          lowTempF={forecast.lowTempF}
          precipPct={forecast.precipProbabilityPct}
          iconSize="h-9 w-9"
          gapClassName="gap-2"
          className="text-lg text-ink-primary"
        />
        {forecast.shortForecast && (
          <span className="max-w-[45%] text-right text-sm text-ink-secondary">{forecast.shortForecast}</span>
        )}
      </div>

      {forecast.segments.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3">
          {forecast.segments.map((s) => (
            <div key={s.segment} className="flex flex-col items-center gap-1 text-center">
              <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {SEGMENT_LABELS[s.segment]}
              </span>
              <WeatherReadout
                iconCode={s.iconCode}
                isDaytime={s.isDaytime}
                tempF={s.tempF}
                precipPct={s.precipPct}
                iconSize="h-5 w-5"
                stacked
                gapClassName="gap-0.5"
                className="text-sm"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
