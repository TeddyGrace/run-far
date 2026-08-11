import { OAuth2Client } from "google-auth-library";
import { eq, and } from "drizzle-orm";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { oauthConnections } from "../../db/schema.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

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

export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
    throw new Error(
      "Google did not return a refresh token — re-authorize with prompt=consent (already set) or revoke prior access at https://myaccount.google.com/permissions",
    );
  }
  await db
    .insert(oauthConnections)
    .values({
      userId,
      provider: "google",
      accessTokenEnc: encryptSecret(tokens.access_token),
      refreshTokenEnc: encryptSecret(tokens.refresh_token),
      expiresAt: new Date(tokens.expiry_date),
      scopes: SCOPES,
    })
    .onConflictDoUpdate({
      target: [oauthConnections.userId, oauthConnections.provider],
      set: {
        accessTokenEnc: encryptSecret(tokens.access_token),
        refreshTokenEnc: encryptSecret(tokens.refresh_token),
        expiresAt: new Date(tokens.expiry_date),
        updatedAt: new Date(),
      },
    });
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
