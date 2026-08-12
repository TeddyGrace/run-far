import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { assistantRoutes } from "./routes/assistant.js";
import { settingsRoutes } from "./routes/settings.js";
import { whoopWebhookRoutes } from "./integrations/whoop/webhooks.js";
import { googleWebhookRoutes } from "./integrations/google/webhooks.js";
import { startWhoopNightlySync } from "./integrations/whoop/nightlySync.js";
import { startGoogleChannelRenewalJob } from "./integrations/google/channelRenewal.js";
import { runMigrations } from "./db/migrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Vite build output — present in the Railway image; absent in local `pnpm dev:api`. */
function webDistPath(): string | null {
  const candidates = [
    path.resolve(here, "../../web/dist"), // apps/api/src → apps/web/dist (tsx)
    path.resolve(here, "../../../web/dist"), // apps/api/dist → apps/web/dist (compiled)
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

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
  await app.register(assistantRoutes);
  await app.register(settingsRoutes);

  // Production: serve the Vite SPA from the same origin so `/api` cookie auth just works.
  const webDist = env.NODE_ENV === "production" ? webDistPath() : null;
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split("?")[0] ?? "";
      if (
        url.startsWith("/api") ||
        url.startsWith("/webhooks") ||
        url.startsWith("/health")
      ) {
        reply.status(404).send({
          error: { message: "Not found", code: "NOT_FOUND" },
        });
        return;
      }
      return reply.sendFile("index.html");
    });
    logger.info({ webDist }, "serving web SPA");
  }

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    // Listen before migrating so the platform health check passes immediately; a slow or
    // failing migration then shows up as a logged error instead of a failed deploy.
    await app.listen({ port: env.listenPort, host: "0.0.0.0" });
    logger.info(`API listening on http://0.0.0.0:${env.listenPort}`);
  } catch (err) {
    logger.error({ err }, "failed to bind port");
    process.exit(1);
  }

  try {
    await runMigrations();
    logger.info("migrations applied");
  } catch (err) {
    logger.error({ err }, "migrations failed — API is up but the schema may be stale");
  }

  startWhoopNightlySync();
  startGoogleChannelRenewalJob();
}

process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));

// Only auto-start when run directly (not when imported by tests).
const entry = process.argv[1] ?? "";
if (entry.endsWith("server.ts") || entry.endsWith("server.js")) {
  main();
}
