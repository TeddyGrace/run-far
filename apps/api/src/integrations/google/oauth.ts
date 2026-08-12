import { OAuth2Client, type Credentials } from "google-auth-library";
import { eq, and } from "drizzle-orm";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { oauthConnections } from "../../db/schema.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  // Send-only — lets the app email the athlete (e.g. the recovery digest) as their own
  // connected account. Never reads or lists mail.
  "https://www.googleapis.com/auth/gmail.send",
];

function newOAuthClient(): OAuth2Client {
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

export function buildAuthorizeUrl(state: string): string {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensure a refresh_token is issued even on re-consent
    scope: SCOPES,
    state,
  });
}

/**
 * Upserts a Google connection from a token response. Google only issues a refresh token
 * on first consent, so a response without one updates the existing row and keeps the
 * stored refresh token. Returns false when there's no refresh token to fall back on —
 * the caller then needs to re-authorize with prompt=consent.
 */
export async function persistGoogleTokens(
  userId: string,
  tokens: Credentials,
  scopes: string[] = SCOPES,
): Promise<boolean> {
  if (!tokens.access_token || !tokens.expiry_date) {
    throw new Error("Google token response is missing an access token or expiry");
  }
  const accessTokenEnc = encryptSecret(tokens.access_token);
  const expiresAt = new Date(tokens.expiry_date);

  if (tokens.refresh_token) {
    await db
      .insert(oauthConnections)
      .values({
        userId,
        provider: "google",
        accessTokenEnc,
        refreshTokenEnc: encryptSecret(tokens.refresh_token),
        expiresAt,
        scopes,
      })
      .onConflictDoUpdate({
        target: [oauthConnections.userId, oauthConnections.provider],
        set: {
          accessTokenEnc,
          refreshTokenEnc: encryptSecret(tokens.refresh_token),
          expiresAt,
          scopes,
          updatedAt: new Date(),
        },
      });
    return true;
  }

  const updated = await db
    .update(oauthConnections)
    .set({ accessTokenEnc, expiresAt, scopes, updatedAt: new Date() })
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")))
    .returning({ id: oauthConnections.id });

  return updated.length > 0;
}

export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  const stored = await persistGoogleTokens(userId, tokens);
  if (!stored) {
    throw new Error(
      "Google did not return a refresh token — re-authorize with prompt=consent (already set) or revoke prior access at https://myaccount.google.com/permissions",
    );
  }
}

/** Returns an OAuth2Client pre-loaded with this user's tokens; google-auth-library
 * handles refresh transparently and we persist the rotated access token afterward. */
export async function getAuthedClient(userId: string): Promise<OAuth2Client> {
  const [conn] = await db
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
  if (!conn) throw new Error(`No Google connection for user ${userId}`);

  const client = newOAuthClient();
  client.setCredentials({
    access_token: decryptSecret(conn.accessTokenEnc),
    refresh_token: decryptSecret(conn.refreshTokenEnc),
    expiry_date: conn.expiresAt.getTime(),
  });

  client.on("tokens", (tokens) => {
    // Google's refresh tokens don't rotate the way Whoop's do, but the access token
    // does change; persist it so the next request doesn't have to refresh again.
    if (tokens.access_token) {
      db.update(oauthConnections)
        .set({
          accessTokenEnc: encryptSecret(tokens.access_token),
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : conn.expiresAt,
          refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : conn.refreshTokenEnc,
          updatedAt: new Date(),
        })
        .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")))
        .catch((err) => logger.error({ err, userId }, "failed to persist refreshed google token"));
    }
  });

  return client;
}

export async function getConnectionMetadata(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const [conn] = await db
    .select({ metadata: oauthConnections.metadata })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
  return (conn?.metadata as Record<string, unknown>) ?? null;
}

export async function setConnectionMetadata(
  userId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(oauthConnections)
    .set({ metadata, updatedAt: new Date() })
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "google")));
}
