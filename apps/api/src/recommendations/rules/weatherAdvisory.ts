import type { Rule, PlannedRunRow } from "../types.js";
import type { NwsAlert } from "../../integrations/weather/weatherClient.js";
import { dateYmdInZone } from "../../lib/zonedTime.js";

const HIGH_HEAT_F = 85;
const HIGH_PRECIP_PCT = 60;

const SEVERITY_RANK: Record<"red" | "yellow" | "info", number> = { red: 3, yellow: 2, info: 1 };

function overlappingAlerts(run: PlannedRunRow, alerts: NwsAlert[]): NwsAlert[] {
  const runStart = run.scheduledAt;
  const runEnd = new Date(runStart.getTime() + (run.durationMin ?? 30) * 60_000);
  return alerts.filter((a) => new Date(a.effective) < runEnd && new Date(a.expires) > runStart);
}

function alertSeverity(alerts: NwsAlert[]): "red" | "yellow" | "info" {
  if (alerts.some((a) => a.severity === "Extreme" || a.severity === "Severe")) return "red";
  return "yellow";
}

/** Flags runs whose forecast day carries an active NWS alert, extreme heat, or a high
 * chance of rain — purely informational (no proposed reschedule), same as acwr-spike. */
export const weatherAdvisory: Rule = ({ upcoming, weatherForecast, timeZone }) => {
  if (weatherForecast.length === 0) return null;
  const forecastByDate = new Map(weatherForecast.map((d) => [d.date, d]));

  const runs = [...upcoming]
    .filter((run) => run.runType !== "rest")
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  const notes: string[] = [];
  let severity: "red" | "yellow" | "info" = "info";

  for (const run of runs) {
    const forecast = forecastByDate.get(dateYmdInZone(run.scheduledAt, timeZone));
    if (!forecast) continue;

    const dayLabel = run.scheduledAt.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone,
    });

    const alerts = overlappingAlerts(run, forecast.alerts);
    if (alerts.length > 0) {
      const runSeverity = alertSeverity(alerts);
      notes.push(`${dayLabel} ${run.runType} run overlaps a ${alerts.map((a) => a.event).join(", ")}.`);
      if (SEVERITY_RANK[runSeverity] > SEVERITY_RANK[severity]) severity = runSeverity;
      continue;
    }

    if (forecast.highTempF != null && forecast.highTempF >= HIGH_HEAT_F) {
      notes.push(`${dayLabel} ${run.runType} run: high of ${Math.round(forecast.highTempF)}°F — plan for heat.`);
      if (SEVERITY_RANK.yellow > SEVERITY_RANK[severity]) severity = "yellow";
      continue;
    }

    if (forecast.precipProbabilityPct != null && forecast.precipProbabilityPct >= HIGH_PRECIP_PCT) {
      notes.push(
        `${dayLabel} ${run.runType} run: ${Math.round(forecast.precipProbabilityPct)}% chance of precipitation.`,
      );
      if (SEVERITY_RANK.yellow > SEVERITY_RANK[severity]) severity = "yellow";
    }
  }

  if (notes.length === 0) return null;

  const summary =
    notes.length === 1 ? "A planned run has a weather advisory this week" : `${notes.length} runs this week have weather advisories`;

  return {
    ruleId: "weather-advisory",
    severity,
    summary,
    reason: notes.join(" "),
    proposedChanges: [],
  };
};
