import { randomBytes } from "node:crypto";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { oauthConnections } from "../../db/schema.js";
import { encryptSecret } from "../../lib/crypto.js";
import type { WhoopTokenResponse } from "./types.js";
import { logger } from "../../lib/logger.js";

export const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

// `offline` requests a refresh token; the rest map 1:1 to the data we read.
const SCOPES = [
  "offline",
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
];

/** Builds the redirect URL for the initial authorization step, returning the CSRF `state`. */
export function buildAuthorizeUrl(): { url: string; state: string } {
  const state = randomBytes(16).toString("hex");
  const url = new URL(WHOOP_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.WHOOP_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.WHOOP_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

async function requestToken(body: URLSearchParams): Promise<WhoopTokenResponse> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Whoop token request failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<WhoopTokenResponse>;
}

/** Exchanges an authorization code for tokens and persists the connection, encrypted. */
export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
    redirect_uri: env.WHOOP_REDIRECT_URI,
  });
  const token = await requestToken(body);
  await upsertConnection(userId, token);
}

/**
 * Refreshes and persists a new token pair.
 *
 * Whoop rotates refresh tokens — the previous one is invalidated the moment a new
 * one is issued. This function's write is the only place a refresh token for this
 * connection should be consumed; callers must not retry the same refresh token twice.
 */
export async function refreshAndStore(
  userId: string,
  currentRefreshToken: string,
): Promise<WhoopTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
  });
  const token = await requestToken(body);
  await upsertConnection(userId, token);
  logger.info({ userId }, "whoop refresh token rotated");
  return token;
}

async function upsertConnection(userId: string, token: WhoopTokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  await db
    .insert(oauthConnections)
    .values({
      userId,
      provider: "whoop",
      accessTokenEnc: encryptSecret(token.access_token),
      refreshTokenEnc: encryptSecret(token.refresh_token),
      expiresAt,
      scopes: token.scope.split(" "),
    })
    .onConflictDoUpdate({
      target: [oauthConnections.userId, oauthConnections.provider],
      set: {
        accessTokenEnc: encryptSecret(token.access_token),
        refreshTokenEnc: encryptSecret(token.refresh_token),
        expiresAt,
        scopes: token.scope.split(" "),
        updatedAt: new Date(),
      },
    });
}
