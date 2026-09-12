import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appleHealthIngestSchema } from "@run-far/shared";

import { ingestAppleHealth } from "../integrations/appleHealth/ingest.js";
import {
  listDevices,
  registerDevice,
  resolveDeviceToken,
  revokeDevice,
  touchDevice,
} from "../integrations/appleHealth/devices.js";
import { getActiveHealthProvider } from "../lib/healthProvider.js";
import { requireUserId } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * The Apple Health endpoints — the one integration where the data comes *to* us.
 *
 * There is no OAuth start/callback pair here, and there never will be: HealthKit has no cloud
 * API and no authorization server. The athlete's consent is granted on the device, to the iOS
 * app, per data type, in Apple's own permission sheet — the server is never party to it and
 * cannot check it. What the server can do is accept what the app sends, which is what this is.
 */

/**
 * Resolve the athlete for an ingest request, which can arrive two ways.
 *
 * From the WebView, the ordinary session cookie is present and is used. From a native
 * background wake — no WebView, no cookies — the device's bearer token is used instead. Both
 * are the athlete's own device; the split exists because HealthKit background delivery runs
 * native code, which is also the case that matters most, since it is what puts this morning's
 * recovery on the dashboard before the athlete opens anything.
 */
async function resolveIngestUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; deviceId: string | null } | null> {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const resolved = await resolveDeviceToken(header.slice("Bearer ".length).trim());
    if (!resolved) {
      // Deliberately indistinguishable from "unknown token": a revoked device learning that its
      // token was once valid tells it nothing useful, and the app's response to both is the
      // same — stop retrying and ask the athlete to reconnect.
      reply.status(401).send({
        error: { message: "Device not authorized", code: "DEVICE_UNAUTHORIZED" },
      });
      return null;
    }
    return { userId: resolved.userId, deviceId: resolved.deviceId };
  }

  const userId = requireUserId(request, reply);
  if (!userId) return null;
  return { userId, deviceId: null };
}

export async function appleHealthRoutes(app: FastifyInstance) {
  /**
   * Register this device and get its push token. Session-authenticated: the athlete is signed
   * in inside the WebView when they tap "Connect Apple Health".
   */
  app.post("/api/apple-health/devices", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = (request.body ?? {}) as { label?: unknown };
    const label = typeof body.label === "string" ? body.label.slice(0, 120) : null;

    const device = await registerDevice(userId, label);
    logger.info({ userId, deviceId: device.id }, "apple health device registered");
    // The only time the raw token ever exists outside the device. Not logged, here or anywhere.
    return { id: device.id, token: device.token };
  });

  app.get("/api/apple-health/devices", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    return listDevices(userId);
  });

  app.delete("/api/apple-health/devices/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const revoked = await revokeDevice(userId, id);
    if (!revoked) {
      reply.status(404).send({ error: { message: "Device not found", code: "NOT_FOUND" } });
      return;
    }
    return { ok: true };
  });

  /**
   * Accept a batch of Apple Health data.
   *
   * Idempotent: the app retries, and its HealthKit anchor windows overlap by design, so the
   * same batch will arrive more than once. Every row is upserted on the provider's own stable
   * UUID, so a replay is a no-op rather than a duplicate.
   */
  app.post("/api/apple-health/ingest", async (request, reply) => {
    const resolved = await resolveIngestUser(request, reply);
    if (!resolved) return;
    const { userId, deviceId } = resolved;

    const payload = appleHealthIngestSchema.parse(request.body);

    // Ingest regardless of which provider is active, and say so in the response rather than
    // refusing. An athlete mid-switch — the iOS app installed and syncing, Whoop still selected
    // — should arrive at Apple Health with their history already there instead of an empty
    // dashboard and a 30-day wait for a baseline. The rows are written but unread until they
    // switch, which is exactly what the provider filter is for.
    const activeProvider = await getActiveHealthProvider(userId);

    const result = await ingestAppleHealth(userId, payload);

    if (deviceId) {
      try {
        await touchDevice(deviceId);
      } catch (err) {
        // Bookkeeping for the Settings list. The data is already committed; failing the request
        // now would have the app resend a batch that landed.
        logger.warn({ err, userId, deviceId }, "failed to stamp device lastSeenAt");
      }
    }

    return {
      ...result,
      activeProvider,
      /** True when this data is being stored but not read, because Whoop is still selected. The
       * app surfaces it as "connected — switch run-far to Apple Health to use it", which is a
       * far better answer than a dashboard that silently ignores a successful sync. */
      storedButNotActive: activeProvider !== "apple_health",
    };
  });
}
