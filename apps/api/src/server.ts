import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { whoopRoutes } from "./routes/whoop.js";
import { planRoutes } from "./routes/plans.js";
import { runRoutes } from "./routes/runs.js";
import { googleRoutes } from "./routes/google.js";
import { recommendationRoutes } from "./routes/recommendations.js";
import { recoveryRoutes } from "./routes/recovery.js";
import { whoopWebhookRoutes } from "./integrations/whoop/webhooks.js";
import { googleWebhookRoutes } from "./integrations/google/webhooks.js";
import { startWhoopNightlySync } from "./integrations/whoop/nightlySync.js";
import { startGoogleChannelRenewalJob } from "./integrations/google/channelRenewal.js";

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — plenty for a TP CSV export
  });

  // Preserve the raw JSON body alongside the parsed one. Needed to verify webhook HMAC
  // signatures (Whoop, and later Google) over the exact bytes the sender signed —
  // re-serializing the parsed object can produce a byte-different string.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      (request as typeof request & { rawBody: string }).rawBody = body as string;
      try {
        const json = body.length ? JSON.parse(body as string) : undefined;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        message: statusCode >= 500 ? "Internal server error" : error.message,
        code: error.code ?? "INTERNAL_ERROR",
      },
    });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(whoopRoutes);
  await app.register(whoopWebhookRoutes);
  await app.register(planRoutes);
  await app.register(runRoutes);
  await app.register(googleRoutes);
  await app.register(googleWebhookRoutes);
  await app.register(recommendationRoutes);
  await app.register(recoveryRoutes);

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
    logger.info(`API listening on http://localhost:${env.API_PORT}`);
    startWhoopNightlySync();
    startGoogleChannelRenewalJob();
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main();
}
