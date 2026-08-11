import { eq, and, lt } from "drizzle-orm";
import { db } from "../../db/client.js";
import { syncState } from "../../db/schema.js";
import { ensureRunningCalendar, watchCalendar, stopWatch } from "./calendarClient.js";
import { logger } from "../../lib/logger.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check 4x/day; channels last up to 7 days
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000; // renew if expiring within a day

export async function registerWatch(userId: string): Promise<void> {
  const calendarId = await ensureRunningCalendar(userId);
  const { channelId, resourceId, expirationMs } = await watchCalendar(userId, calendarId);
  await db
    .insert(syncState)
    .values({
      userId,
      provider: "google",
      channelId,
      channelExpiration: new Date(expirationMs),
    })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.provider],
      set: { channelId, channelExpiration: new Date(expirationMs), updatedAt: new Date() },
    });
  // resourceId isn't in our schema as its own column; stash it in the channelId slot's
  // sibling via metadata would be cleaner, but for renewal we only strictly need channelId
  // to look up which user a webhook belongs to, and resourceId to call channels.stop.
  // Store it alongside for renewal's benefit.
  resourceIdCache.set(userId, resourceId);
}

// In-memory cache of resourceId per user, used only to gracefully stop the previous
// channel on renewal. Losing this on restart just means the old channel expires on its
// own TTL instead of being stopped early — harmless.
const resourceIdCache = new Map<string, string>();

async function renewExpiringChannels(): Promise<void> {
  const cutoff = new Date(Date.now() + RENEW_WITHIN_MS);
  const expiring = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.provider, "google"), lt(syncState.channelExpiration, cutoff)));

  for (const state of expiring) {
    try {
      const oldResourceId = resourceIdCache.get(state.userId);
      if (state.channelId && oldResourceId) {
        await stopWatch(state.userId, state.channelId, oldResourceId);
      }
      await registerWatch(state.userId);
      logger.info({ userId: state.userId }, "renewed google calendar watch channel");
    } catch (err) {
      logger.error({ err, userId: state.userId }, "failed to renew google watch channel");
    }
  }
}

export function startGoogleChannelRenewalJob(): NodeJS.Timeout {
  const timer = setInterval(() => {
    renewExpiringChannels().catch((err) => logger.error({ err }, "channel renewal sweep failed"));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
