import { gmail_v1, google } from "googleapis";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { oauthConnections } from "../../db/schema.js";
import { getAuthedClient } from "./oauth.js";

export async function hasGoogleConnection(userId: string): Promise<boolean> {
  const [conn] = await db
    .select({ id: oauthConnections.id })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
  return Boolean(conn);
}

async function getGmailApi(userId: string): Promise<gmail_v1.Gmail> {
  const auth = await getAuthedClient(userId);
  return google.gmail({ version: "v1", auth });
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeaderWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** Builds an RFC 2822 multipart/alternative message, base64url-encoded for the Gmail API's
 * `raw` field. No From header — Gmail always sets it to the authenticated account, and
 * setting anything else there is rejected unless it's a verified send-as alias. */
function buildRawMessage(params: { to: string; subject: string; html: string; text: string }): string {
  const boundary = `runfar_${Date.now()}`;
  const message = [
    `To: ${params.to}`,
    `Subject: ${encodeHeaderWord(params.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(params.text, "utf8").toString("base64"),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(params.html, "utf8").toString("base64"),
    "",
    `--${boundary}--`,
  ].join("\r\n");

  return base64url(message);
}

/** Sends an email as the athlete's own connected Google account via the Gmail API.
 * Requires the `gmail.send` scope on their Google OAuth connection — throws if that
 * connection doesn't exist; callers should check `hasGoogleConnection` first. */
export async function sendGmail(
  userId: string,
  params: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  const api = await getGmailApi(userId);
  await api.users.messages.send({
    userId: "me",
    requestBody: { raw: buildRawMessage(params) },
  });
}
