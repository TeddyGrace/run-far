import type { BusyPeriod, Rule, PlannedRunRow } from "../types.js";
import type { NwsAlert, WeatherHour } from "../../integrations/weather/weatherClient.js";
import { dateYmdInZone, hourInZone } from "../../lib/zonedTime.js";
import { overlaps } from "./shared.js";

const HIGH_HEAT_F = 85;
const HIGH_PRECIP_PCT = 60;

/** Hours a person will plausibly run between, in their own wall clock. Without a bound the
 * search happily proposes 3am, which is technically the coolest hour and not an offer anyone
 * wants. */
const EARLIEST_LOCAL_HOUR = 5;
const LATEST_LOCAL_HOUR = 21;

/** Don't offer to move a run less than this — shuffling a session by half an hour is churn, not
 * advice, and the forecast is not precise enough to justify it. */
const MIN_WORTHWHILE_SHIFT_MIN = 60;

const SEVERITY_RANK: Record<"red" | "yellow" | "info", number> = { red: 3, yellow: 2, info: 1 };

function runEnd(run: PlannedRunRow, start: Date = run.scheduledAt): Date {
  // Mirrors calendarConflict's default for a run with no duration recorded.
  return new Date(start.getTime() + (run.durationMin ?? 30) * 60_000);
}

function overlappingAlerts(run: PlannedRunRow, alerts: NwsAlert[], start = run.scheduledAt): NwsAlert[] {
  const end = runEnd(run, start);
  return alerts.filter((a) => new Date(a.effective) < end && new Date(a.expires) > start);
}

function alertSeverity(alerts: NwsAlert[]): "red" | "yellow" | "info" {
  if (alerts.some((a) => a.severity === "Extreme" || a.severity === "Severe")) return "red";
  return "yellow";
}

/**
 * The hourly rows a run placed at `start` actually overlaps. Empty when the forecast has no
 * hourly detail for that stretch, which is the signal to fall back to the day summary.
 *
 * Each row describes the hour beginning at its own timestamp, so the test is interval overlap
 * rather than "timestamp inside the run". Anything looser pulls in the hour *before* the run —
 * which would reject a 10am start because 9am was hot, an hour the athlete is not running in.
 */
function hoursCovering(run: PlannedRunRow, start: Date, hourly: WeatherHour[]): WeatherHour[] {
  const end = runEnd(run, start);
  return hourly.filter((h) => {
    const hourStart = new Date(h.time).getTime();
    const hourEnd = hourStart + 60 * 60_000;
    return hourStart < end.getTime() && hourEnd > start.getTime();
  });
}

function hoursAreRunnable(hours: WeatherHour[]): boolean {
  if (hours.length === 0) return false; // unknown is not the same as fine
  return hours.every(
    (h) =>
      (h.tempF == null || h.tempF < HIGH_HEAT_F) &&
      (h.precipPct == null || h.precipPct < HIGH_PRECIP_PCT),
  );
}

interface Advisory {
  run: PlannedRunRow;
  note: string;
  severity: "red" | "yellow" | "info";
  /** A better start time on the same day, when one exists and is worth taking. */
  betterStart: Date | null;
}

/**
 * The nearest start time on the run's own day that clears both thresholds, is free of alerts,
 * and collides with nothing.
 *
 * Same day on purpose. Moving a session to a different day is a change to the training plan and
 * the recovery rules already own that decision (see sleepDebt); moving it a few hours is a change
 * to nothing but the athlete's morning, which is why this one is safe to propose off a forecast.
 *
 * "Nearest" rather than "coolest": the coolest hour of a hot day is 5am every time, and a rule
 * that always says 5am is a rule the athlete stops reading. The least disruptive hour that is
 * actually fine is the useful answer.
 */
function findBetterStart(
  run: PlannedRunRow,
  hourly: WeatherHour[],
  alerts: NwsAlert[],
  busyPeriods: BusyPeriod[],
  sameDayRuns: PlannedRunRow[],
  timeZone: string,
  now: Date,
): Date | null {
  const runDate = dateYmdInZone(run.scheduledAt, timeZone);

  const candidates = hourly
    .map((h) => new Date(h.time))
    .filter((start) => {
      if (dateYmdInZone(start, timeZone) !== runDate) return false;
      const localHour = hourInZone(start, timeZone);
      if (localHour < EARLIEST_LOCAL_HOUR || localHour > LATEST_LOCAL_HOUR) return false;
      // Can't move a run into the past, and a shift too small to matter is just churn.
      if (start.getTime() <= now.getTime()) return false;
      return Math.abs(start.getTime() - run.scheduledAt.getTime()) >= MIN_WORTHWHILE_SHIFT_MIN * 60_000;
    })
    .sort(
      (a, b) =>
        Math.abs(a.getTime() - run.scheduledAt.getTime()) -
        Math.abs(b.getTime() - run.scheduledAt.getTime()),
    );

  for (const start of candidates) {
    if (!hoursAreRunnable(hoursCovering(run, start, hourly))) continue;
    if (overlappingAlerts(run, alerts, start).length > 0) continue;

    const end = runEnd(run, start);
    // A slot the athlete is already committed to isn't an improvement. The calendar-conflict
    // rule would immediately object to a move this rule had just made.
    if (busyPeriods.some((b) => overlaps(start, end, b))) continue;
    if (
      sameDayRuns.some(
        (other) => other.id !== run.id && overlaps(start, end, { start: other.scheduledAt, end: runEnd(other) }),
      )
    ) {
      continue;
    }
    return start;
  }
  return null;
}

/**
 * Runs whose forecast carries an active NWS alert, extreme heat, or a high chance of rain.
 *
 * Where the hourly forecast supports it this now proposes a concrete time — the nearest hour on
 * the same day that is actually fine — rather than only warning. A run's start time is the one
 * thing about it that moves without changing the training at all, so weather is the input best
 * suited to acting on rather than reporting.
 *
 * Hourly data also makes the *flag* sharper. Judging heat off the day's high, as this used to,
 * means a 6am run gets a heat warning because the afternoon hits 95°F — the advice was already
 * wrong, and proposing a move off it would have been worse. The day summary stays as the
 * fallback for forecasts with no hourly detail.
 */
export const weatherAdvisory: Rule = ({ upcoming, weatherForecast, busyPeriods, timeZone, now }) => {
  if (weatherForecast.length === 0) return null;
  const forecastByDate = new Map(weatherForecast.map((d) => [d.date, d]));

  const runs = [...upcoming]
    .filter((run) => run.runType !== "rest")
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  const advisories: Advisory[] = [];

  for (const run of runs) {
    const runDate = dateYmdInZone(run.scheduledAt, timeZone);
    const forecast = forecastByDate.get(runDate);
    if (!forecast) continue;

    const dayLabel = run.scheduledAt.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
    });
    const hourly = forecast.hourly ?? [];
    const sameDayRuns = runs.filter((r) => dateYmdInZone(r.scheduledAt, timeZone) === runDate);
    const better = () =>
      findBetterStart(run, hourly, forecast.alerts, busyPeriods ?? [], sameDayRuns, timeZone, now);

    const alerts = overlappingAlerts(run, forecast.alerts);
    if (alerts.length > 0) {
      advisories.push({
        run,
        severity: alertSeverity(alerts),
        note: `${dayLabel} ${run.runType} run overlaps a ${alerts.map((a) => a.event).join(", ")}.`,
        betterStart: better(),
      });
      continue;
    }

    const covering = hoursCovering(run, run.scheduledAt, hourly);
    if (covering.length > 0) {
      // Hourly detail available: judge the hours the run actually covers.
      const hottest = covering.reduce<number | null>(
        (acc, h) => (h.tempF != null && (acc == null || h.tempF > acc) ? h.tempF : acc),
        null,
      );
      const wettest = covering.reduce<number | null>(
        (acc, h) => (h.precipPct != null && (acc == null || h.precipPct > acc) ? h.precipPct : acc),
        null,
      );

      if (hottest != null && hottest >= HIGH_HEAT_F) {
        advisories.push({
          run,
          severity: "yellow",
          note: `${dayLabel} ${run.runType} run: ${Math.round(hottest)}°F at the scheduled time.`,
          betterStart: better(),
        });
        continue;
      }
      if (wettest != null && wettest >= HIGH_PRECIP_PCT) {
        advisories.push({
          run,
          severity: "yellow",
          note: `${dayLabel} ${run.runType} run: ${Math.round(wettest)}% chance of precipitation at the scheduled time.`,
          betterStart: better(),
        });
      }
      continue;
    }

    // No hourly detail — fall back to the day summary, and stay advisory. Proposing an hour
    // off a daily high would be guessing at which hour is better.
    if (forecast.highTempF != null && forecast.highTempF >= HIGH_HEAT_F) {
      advisories.push({
        run,
        severity: "yellow",
        note: `${dayLabel} ${run.runType} run: high of ${Math.round(forecast.highTempF)}°F — plan for heat.`,
        betterStart: null,
      });
      continue;
    }
    if (forecast.precipProbabilityPct != null && forecast.precipProbabilityPct >= HIGH_PRECIP_PCT) {
      advisories.push({
        run,
        severity: "yellow",
        note: `${dayLabel} ${run.runType} run: ${Math.round(forecast.precipProbabilityPct)}% chance of precipitation.`,
        betterStart: null,
      });
    }
  }

  if (advisories.length === 0) return null;

  const severity = advisories.reduce<"red" | "yellow" | "info">(
    (acc, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[acc] ? a.severity : acc),
    "info",
  );

  // At most one run is proposed for — arbitration allows a card to own only one run anyway, and
  // a card that moved three sessions at once would be a bigger decision than a forecast earns.
  const actionable = advisories.find((a) => a.betterStart != null);
  const notes = advisories.map((a) => a.note).join(" ");

  if (!actionable || !actionable.betterStart) {
    return {
      ruleId: "weather-advisory",
      severity,
      summary:
        advisories.length === 1
          ? "A planned run has a weather advisory this week"
          : `${advisories.length} runs this week have weather advisories`,
      reason: notes,
      proposedChanges: [],
    };
  }

  const timeLabel = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const dayLabel = actionable.run.scheduledAt.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone,
  });
  const others =
    advisories.length > 1 ? ` Other runs flagged this week: ${advisories.filter((a) => a !== actionable).map((a) => a.note).join(" ")}` : "";

  return {
    ruleId: "weather-advisory",
    severity,
    summary: `Move ${dayLabel}'s ${actionable.run.runType} run to ${timeLabel(actionable.betterStart)}`,
    reason: `${actionable.note} ${timeLabel(actionable.betterStart)} is the nearest time that day that's clear of it, and nothing else on your calendar conflicts with it. The session itself doesn't change — only when you head out.${others}`,
    proposedChanges: [
      {
        plannedRunId: actionable.run.id,
        field: "scheduledAt",
        from: actionable.run.scheduledAt.toISOString(),
        to: actionable.betterStart.toISOString(),
      },
    ],
  };
};
