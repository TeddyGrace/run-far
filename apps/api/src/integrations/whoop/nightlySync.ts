import { db } from "../../db/client.js";
import { oauthConnections } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { incrementalSyncWhoop } from "./sync.js";
import { logger } from "../../lib/logger.js";

const INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day is enough for a safety net

async function runForAllConnectedUsers(): Promise<void> {
  const connections = await db
    .select({ userId: oauthConnections.userId })
    .from(oauthConnections)
    .where(eq(oauthConnections.provider, "whoop"));

  for (const { userId } of connections) {
    try {
      await incrementalSyncWhoop(userId);
    } catch (err) {
      logger.error({ err, userId }, "nightly whoop sync failed for user");
    }
  }
}

/**
 * Safety net for missed webhooks: periodically re-runs incremental sync for every
 * connected user, independent of whether their webhooks fired. Not a replacement for
 * webhooks — just insurance against dropped deliveries or downtime.
 */
export function startWhoopNightlySync(): NodeJS.Timeout {
  const timer = setInterval(() => {
    runForAllConnectedUsers().catch((err) => logger.error({ err }, "nightly whoop sync sweep failed"));
  }, INTERVAL_MS);
  // Don't let this timer keep the process alive on its own if everything else is done.
  timer.unref?.();
  return timer;
}
