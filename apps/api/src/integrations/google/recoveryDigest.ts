import { and, eq } from "drizzle-orm";
import type { RecoverySnapshot } from "@run-far/shared";
import { db } from "../../db/client.js";
import { recommendations, users } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";
import { buildRecoverySnapshot } from "../../recommendations/snapshot.js";
import type { RuleOutput } from "../../recommendations/types.js";
import { hasGoogleConnection, sendGmail } from "./gmailClient.js";

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
  return `${h}:${String(m).padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDigest(
  snapshot: RecoverySnapshot,
  fired: DigestItem[],
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
    ["Sleep debt (7d)", fmtDuration(snapshot.sleepDebtMin7d)],
    ["Strain (avg/day, 7d)", fmt(snapshot.strain7d != null ? snapshot.strain7d / 7 : null, 1)],
    ["ACWR", fmt(snapshot.acwr, 2)],
  ];

  const recText = fired.length
    ? fired.map((r) => `- [${r.severity.toUpperCase()}] ${r.summary}\n  ${r.reason}`).join("\n\n")
    : "No recommendations today — nothing needs attention.";

  const text = `Today's recovery (${snapshot.date})\n\n${statLines
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n")}\n\nRecommendations\n${recText}`;

  const recHtml = fired.length
    ? `<ul style="padding-left:18px;margin:0;">${fired
        .map(
          (r) =>
            `<li style="margin-bottom:10px;"><strong>[${r.severity.toUpperCase()}]</strong> ${escapeHtml(r.summary)}<br><span style="color:#6C7A73;">${escapeHtml(r.reason)}</span></li>`,
        )
        .join("")}</ul>`
    : `<p style="color:#6C7A73;">No recommendations today — nothing needs attention.</p>`;

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
    </div>`;

  return { subject, html, text };
}

/**
 * Sends the daily recovery/recommendations digest via Gmail (as the athlete's own connected
 * Google account) at most once per calendar day (`snapshot.date`, already the athlete-local
 * date the recommendation engine computed against). Only meant to be called from the
 * ingestion path (Whoop webhooks) — never from a passive dashboard read — so the gate
 * reflects "new data landed today," not "someone opened the app today." No-op (and never
 * throws) if Google isn't connected.
 */
export async function maybeSendRecoveryDigest(
  userId: string,
  snapshot: RecoverySnapshot,
  fired: RuleOutput[],
): Promise<void> {
  if (!(await hasGoogleConnection(userId))) return;

  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return;
    if (user.lastRecoveryEmailDate === snapshot.date) return; // already sent today

    const { subject, html, text } = buildDigest(snapshot, fired);
    await sendGmail(userId, { to: user.email, subject, html, text });
    await db.update(users).set({ lastRecoveryEmailDate: snapshot.date }).where(eq(users.id, userId));
    logger.info({ userId, date: snapshot.date }, "recovery digest email sent");
  } catch (err) {
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
  if (!(await hasGoogleConnection(userId))) {
    return { sent: false, reason: "Google isn't connected — connect it in Settings to enable email." };
  }

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
    const { subject, html, text } = buildDigest(snapshot, fired);
    await sendGmail(userId, { to: user.email, subject, html, text });
    await db.update(users).set({ lastRecoveryEmailDate: snapshot.date }).where(eq(users.id, userId));
    logger.info({ userId, date: snapshot.date }, "recovery digest email sent (chat-requested)");
    return { sent: true };
  } catch (err) {
    logger.error({ err, userId }, "failed to send recovery digest email (chat-requested)");
    return { sent: false, reason: "Email failed to send — check server logs." };
  }
}
