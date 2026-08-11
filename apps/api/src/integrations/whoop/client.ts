import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { oauthConnections } from "../../db/schema.js";
import { decryptSecret } from "../../lib/crypto.js";
import { refreshAndStore } from "./oauth.js";
import { logger } from "../../lib/logger.js";
import type { WhoopPaginated } from "./types.js";

// Base REST URL; callers pass paths like "/v2/recovery", "/v2/activity/sleep", etc.
const API_BASE = "https://api.prod.whoop.com";

// Refresh tokens rotate: two concurrent refreshes for the same connection would race,
// with the second call's refresh_token already invalidated by the first. Serialize
// refreshes per user so only one is ever in flight.
const refreshLocks = new Map<string, Promise<string>>();

async function getConnection(userId: string) {
  const [conn] = await db
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, "whoop")));
  if (!conn) throw new Error(`No Whoop connection for user ${userId}`);
  return conn;
}

/** Returns a valid (non-expired) access token, refreshing first if needed. */
async function getValidAccessToken(userId: string): Promise<string> {
  const conn = await getConnection(userId);
  const expiresInMs = conn.expiresAt.getTime() - Date.now();
  if (expiresInMs > 60_000) {
    return decryptSecret(conn.accessTokenEnc);
  }

  const existingLock = refreshLocks.get(userId);
  if (existingLock) return existingLock;

  const lock = (async () => {
    try {
      // Re-read: another request may have refreshed while we were waiting to acquire the lock.
      const fresh = await getConnection(userId);
      if (fresh.expiresAt.getTime() - Date.now() > 60_000) {
        return decryptSecret(fresh.accessTokenEnc);
      }
      const refreshToken = decryptSecret(fresh.refreshTokenEnc);
      const token = await refreshAndStore(userId, refreshToken);
      return token.access_token;
    } finally {
      refreshLocks.delete(userId);
    }
  })();
  refreshLocks.set(userId, lock);
  return lock;
}

interface WhoopRequestOptions {
  query?: Record<string, string | number | undefined>;
}

/** Low-level authenticated GET against the Whoop v2 API, with 429 backoff. */
export async function whoopGet<T>(
  userId: string,
  path: string,
  opts: WhoopRequestOptions = {},
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const accessToken = await getValidAccessToken(userId);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 429) {
      const resetHeader = res.headers.get("X-RateLimit-Reset");
      const resetMs = resetHeader ? Number(resetHeader) * 1000 - Date.now() : 1000 * attempt;
      const waitMs = Math.max(500, Math.min(resetMs, 15_000));
      logger.warn({ userId, path, attempt, waitMs }, "whoop rate limited, backing off");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Whoop API ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  throw new Error(`Whoop API ${path} failed after ${maxAttempts} attempts (rate limited)`);
}

/** Pages through a Whoop v2 list endpoint, yielding all records across the date range. */
export async function* whoopPaginate<T>(
  userId: string,
  path: string,
  query: { start?: string; end?: string } = {},
): AsyncGenerator<T> {
  let nextToken: string | undefined;
  do {
    const page = await whoopGet<WhoopPaginated<T>>(userId, path, {
      query: { limit: 25, start: query.start, end: query.end, nextToken },
    });
    for (const record of page.records) yield record;
    nextToken = page.next_token ?? undefined;
  } while (nextToken);
}
