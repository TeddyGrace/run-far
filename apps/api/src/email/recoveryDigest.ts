import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { RecoverySnapshot, WeatherHour } from "@run-far/shared";
import { db } from "../db/client.js";
import { recommendations, users, weatherForecasts } from "../db/schema.js";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { sendMail } from "../lib/mailer.js";
import { buildRecoverySnapshot } from "../recommendations/snapshot.js";
import type { RuleOutput } from "../recommendations/types.js";

/** The digest only reads severity/summary/reason — satisfied by both a freshly-evaluated
 * RuleOutput and a persisted `recommendations` row. */
interface DigestItem {
  severity: string;
  summary: string;
  reason: string;
}

function fmt(n: number | null, digits = 0, suffix = ""): string {
  return n == null ? "—" : `${n.toFixed(digits)}${suffix}`;
}

function fmtDuration(min: number | null): string {
  if (min == null) return "—";
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface WeatherDigestHour {
  label: string;
  tempF: number | null;
  precipPct: number | null;
}

interface WeatherDigestData {
  highTempF: number | null;
  lowTempF: number | null;
  precipProbabilityPct: number | null;
  shortForecast: string | null;
  hours: WeatherDigestHour[];
}

/** Reads today's persisted forecast (kept fresh by generateRecommendations — see
 * routes/weather.ts for the same read pattern) and formats its hourly breakdown in the
 * athlete's local timezone, 12-hour clock, for the email. Returns null if no location is
 * configured or no forecast has landed yet for today. */
async function getTodayWeatherForDigest(
  userId: string,
  dateYmd: string,
  timeZone: string,
): Promise<WeatherDigestData | null> {
  const [row] = await db
    .select()
    .from(weatherForecasts)
    .where(and(eq(weatherForecasts.userId, userId), eq(weatherForecasts.date, dateYmd)));
  if (!row) return null;

  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: true,
  });
  const hourly = (row.hourly as WeatherHour[]) ?? [];
  const hours = hourly.map((h) => ({
    label: hourFmt.format(new Date(h.time)),
    tempF: h.tempF,
    precipPct: h.precipPct,
  }));

  return {
    highTempF: row.highTempF,
    lowTempF: row.lowTempF,
    precipProbabilityPct: row.precipProbabilityPct,
    shortForecast: row.shortForecast,
    hours,
  };
}

function buildDigest(
  snapshot: RecoverySnapshot,
  fired: DigestItem[],
  weather: WeatherDigestData | null,
): { subject: string; html: string; text: string } {
  const score = snapshot.recoveryScore != null ? Math.round(snapshot.recoveryScore) : null;
  const flagWord = fired.length === 1 ? "flag" : "flags";
  const subject =
    score != null
      ? `run-far: recovery ${score} today — ${fired.length ? `${fired.length} ${flagWord}` : "no flags"}`
      : "run-far: today's recovery update";

  const statLines = [
    ["Recovery", fmt(snapshot.recoveryScore)],
    ["HRV", `${fmt(snapshot.hrvRmssdMs, 0, "ms")} (baseline ${fmt(snapshot.hrvBaselineMs, 0, "ms")})`],
    ["Resting HR", fmt(snapshot.restingHr, 0, "bpm")],
    ["Sleep debt (today)", fmtDuration(snapshot.sleepDebtMinToday)],
    [
      `Avg cycle strain (${snapshot.cyclesCounted7d} cycles)`,
      fmt(snapshot.cycleStrainAvg7d, 1),
    ],
    ["ACWR", fmt(snapshot.acwr, 2)],
  ];

  const recText = fired.length
    ? fired.map((r) => `- [${r.severity.toUpperCase()}] ${r.summary}\n  ${r.reason}`).join("\n\n")
    : "No recommendations today — nothing needs attention.";

  const weatherHeadline = weather
    ? `${fmt(weather.highTempF, 0, "°")}/${fmt(weather.lowTempF, 0, "°")}${
        weather.shortForecast ? ` — ${weather.shortForecast}` : ""
      }${weather.precipProbabilityPct ? ` (${Math.round(weather.precipProbabilityPct)}% chance of rain)` : ""}`
    : null;

  const weatherText = weather
    ? `\n\nToday's weather: ${weatherHeadline}\n${weather.hours
        .map((h) => `${h.label}: ${fmt(h.tempF, 0, "°")}${h.precipPct ? ` (${Math.round(h.precipPct)}% rain)` : ""}`)
        .join("\n")}`
    : "";

  const text = `Today's recovery (${snapshot.date})\n\n${statLines
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n")}\n\nRecommendations\n${recText}${weatherText}`;

  const recHtml = fired.length
    ? `<ul style="padding-left:18px;margin:0;">${fired
        .map(
          (r) =>
            `<li style="margin-bottom:10px;"><strong>[${r.severity.toUpperCase()}]</strong> ${escapeHtml(r.summary)}<br><span style="color:#6C7A73;">${escapeHtml(r.reason)}</span></li>`,
        )
        .join("")}</ul>`
    : `<p style="color:#6C7A73;">No recommendations today — nothing needs attention.</p>`;

  const weatherHtml = weather
    ? `
      <h3 style="margin-bottom:8px;">Today's weather</h3>
      <p style="margin:0 0 10px;">${escapeHtml(weatherHeadline!)}</p>
      ${
        weather.hours.length
          ? `<div style="overflow-x:auto;">
              <table style="border-collapse:collapse;"><tr>
                ${weather.hours
                  .map(
                    (h) =>
                      `<td style="text-align:center;padding:4px 8px;border-top:1px solid #E4E1D8;font-size:12px;white-space:nowrap;">
                        <div style="color:#6C7A73;">${escapeHtml(h.label)}</div>
                        <div><strong>${fmt(h.tempF, 0, "°")}</strong></div>
                        <div style="color:${h.precipPct != null && h.precipPct >= 30 ? "#4FB0A6" : "#6C7A73"};">${h.precipPct ? `${Math.round(h.precipPct)}%` : ""}</div>
                      </td>`,
                  )
                  .join("")}
              </tr></table>
            </div>`
          : ""
      }`
    : "";

  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;color:#1B2320;">
      <h2 style="margin-bottom:4px;">Today's recovery: ${score ?? "—"}</h2>
      <p style="color:#6C7A73;margin-top:0;">${snapshot.date}</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        ${statLines
          .map(
            ([label, value]) =>
              `<tr><td style="padding:2px 16px 2px 0;color:#6C7A73;">${label}</td><td><strong>${value}</strong></td></tr>`,
          )
          .join("")}
      </table>
      <h3 style="margin-bottom:8px;">Recommendations</h3>
      ${recHtml}
      ${weatherHtml}
    </div>`;

  return { subject, html, text };
}

/**
 * Sends the daily recovery/recommendations digest via email at most once per calendar day
 * (`snapshot.date`, the athlete-local date buildRecoverySnapshot computed against — see
 * snapshot.ts). Only meant to be called from the ingestion path (Whoop webhooks) — never from
 * a passive dashboard read — so the gate reflects "new data landed today," not "someone
 * opened the app today."
 */
export async function maybeSendRecoveryDigest(
  userId: string,
  snapshot: RecoverySnapshot,
  fired: RuleOutput[],
): Promise<void> {
  // Claim the day atomically *before* sending, via a single conditional UPDATE, instead of the
  // read-then-write this replaced (check lastRecoveryEmailDate, send, then set it) — that gap
  // let two concurrent callers for the same user (paired webhooks, or a webhook racing a
  // dashboard read) both read "not sent yet" and both send. Only the caller whose UPDATE
  // actually matches a row has won the claim.
  const previous = await db
    .select({ lastRecoveryEmailDate: users.lastRecoveryEmailDate })
    .from(users)
    .where(eq(users.id, userId));
  if (!previous[0]) return;
  const prevDate = previous[0].lastRecoveryEmailDate;

  const claimed = await db
    .update(users)
    .set({ lastRecoveryEmailDate: snapshot.date })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.lastRecoveryEmailDate), ne(users.lastRecoveryEmailDate, snapshot.date)),
      ),
    )
    .returning({ email: users.email });
  const claimedUser = claimed[0];
  if (!claimedUser) return; // another caller already claimed today

  try {
    const weather = await getTodayWeatherForDigest(userId, snapshot.date, snapshot.timeZone ?? env.ATHLETE_TIMEZONE);
    const { subject, html, text } = buildDigest(snapshot, fired, weather);
    await sendMail({ to: claimedUser.email, subject, html, text });
    logger.info({ userId, date: snapshot.date }, "recovery digest email sent");
  } catch (err) {
    // Send failed after we'd already claimed the day — release the claim so a retry (or
    // tomorrow's regen re-running today's date, e.g. a late-night cycle) can still go out.
    await db.update(users).set({ lastRecoveryEmailDate: prevDate }).where(eq(users.id, userId));
    logger.error({ err, userId }, "failed to send recovery digest email");
  }
}

/**
 * Sends the recovery/recommendations digest right now, on explicit request (e.g. the chat
 * assistant's send_recovery_email tool) — unlike `maybeSendRecoveryDigest`, this ignores the
 * once-per-day gate, since an explicit ask should never be silently swallowed. It still
 * updates the gate on success so a later automatic webhook-triggered send that same day
 * doesn't duplicate it.
 */
export async function sendRecoveryDigestNow(
  userId: string,
): Promise<{ sent: boolean; reason?: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return { sent: false, reason: "User not found." };

  const snapshot = await buildRecoverySnapshot(userId);
  const pending = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")));
  const fired: DigestItem[] = pending.map((r) => ({
    severity: r.severity,
    summary: r.summary,
    reason: r.reason,
  }));

  try {
    const weather = await getTodayWeatherForDigest(userId, snapshot.date, snapshot.timeZone ?? env.ATHLETE_TIMEZONE);
    const { subject, html, text } = buildDigest(snapshot, fired, weather);
    await sendMail({ to: user.email, subject, html, text });
    await db.update(users).set({ lastRecoveryEmailDate: snapshot.date }).where(eq(users.id, userId));
    logger.info({ userId, date: snapshot.date }, "recovery digest email sent (chat-requested)");
    return { sent: true };
  } catch (err) {
    logger.error({ err, userId }, "failed to send recovery digest email (chat-requested)");
    return { sent: false, reason: "Email failed to send — check server logs." };
  }
}
