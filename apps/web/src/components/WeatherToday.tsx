import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { WeatherForecastResponse } from "@run-far/shared";
import { api } from "../lib/api.js";
import { WeatherReadout } from "./WeatherReadout.js";

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const ROLLING_WINDOW_HOURS = 24;

function hourLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getHours() === now.getHours()) {
    return "Now";
  }
  return d.toLocaleTimeString(undefined, { hour: "numeric" }).replace(" ", "").toLowerCase();
}

export function WeatherToday() {
  const today = todayYmd();
  const tomorrow = tomorrowYmd();
  const weatherQuery = useQuery<WeatherForecastResponse>({
    queryKey: ["weather", today, tomorrow],
    queryFn: () => api.get<WeatherForecastResponse>(`/weather/forecast?from=${today}&to=${tomorrow}`),
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

  const now = new Date();
  const windowEnd = now.getTime() + ROLLING_WINDOW_HOURS * 60 * 60 * 1000;
  const allHours = [...forecast.hourly, ...(weatherQuery.data?.forecasts[1]?.hourly ?? [])];
  const upcomingHours = allHours.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= now.getTime() - 30 * 60 * 1000 && t <= windowEnd;
  });

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

      {upcomingHours.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
            Hour by hour
          </h3>
          <div className="-mx-1 flex snap-x snap-mandatory gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
            {upcomingHours.map((h) => (
              <div
                key={h.time}
                className="flex shrink-0 snap-start flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-center first:bg-accent/[0.08]"
                title={h.shortForecast ?? undefined}
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                  {hourLabel(h.time)}
                </span>
                <WeatherReadout
                  iconCode={h.iconCode}
                  isDaytime={h.isDaytime}
                  tempF={h.tempF}
                  precipPct={h.precipPct}
                  iconSize="h-5 w-5"
                  stacked
                  gapClassName="gap-0.5"
                  className="text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
