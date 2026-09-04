import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
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
import { weatherRoutes } from "./routes/weather.js";
import { assistantRoutes } from "./routes/assistant.js";
import { settingsRoutes } from "./routes/settings.js";
import { adminRoutes } from "./routes/admin.js";
import { billingRoutes } from "./routes/billing.js";
import { accountRoutes } from "./routes/account.js";
import { whoopWebhookRoutes } from "./integrations/whoop/webhooks.js";
import { googleWebhookRoutes } from "./integrations/google/webhooks.js";
import { stripeWebhookRoutes } from "./integrations/stripe/webhooks.js";
import { startWhoopNightlySync } from "./integrations/whoop/nightlySync.js";
import { startGoogleChannelRenewalJob } from "./integrations/google/channelRenewal.js";
import { runMigrations } from "./db/migrate.js";
import { reconcileAdminEmails } from "./lib/adminBootstrap.js";
import { activeUserGuard } from "./lib/activeUser.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Vite build output for `app` (e.g. "web", "backoffice") — present in the Railway image;
 * absent in local `pnpm dev:api`. */
function distPath(app: string): string | null {
  const candidates = [
    path.resolve(here, `../../${app}/dist`), // apps/api/src → apps/{app}/dist (tsx)
    path.resolve(here, `../../../${app}/dist`), // apps/api/dist → apps/{app}/dist (compiled)
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
  app.addHook("onRequest", activeUserGuard);
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
    // A ZodError from a route's schema.parse() carries no statusCode, so without this it
    // falls through to a 500 "Internal server error" and the caller never learns which
    // field was wrong — bad for any route, worse for the public signup/reset forms.
    // Built from issue path + message only, never the received value, so a rejected
    // password is never echoed back.
    if (error instanceof ZodError) {
      const detail = error.issues
        .map((issue) => {
          const field = issue.path.join(".");
          return field ? `${field}: ${issue.message}` : issue.message;
        })
        .join("; ");
      request.log.info({ issues: error.issues.map((i) => i.path.join(".")) }, "request rejected: invalid input");
      reply.status(400).send({
        error: { message: detail || "Invalid request", code: "INVALID_INPUT" },
      });
      return;
    }

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
  await app.register(weatherRoutes);
  await app.register(assistantRoutes);
  await app.register(settingsRoutes);
  await app.register(adminRoutes);
  await app.register(billingRoutes);
  await app.register(accountRoutes);
  await app.register(stripeWebhookRoutes);

  // Production: serve the Vite SPA(s) from the same origin so `/api` cookie auth just works.
  // The backoffice SPA is scoped to its own host via a Fastify/find-my-way host constraint
  // (passed straight through to @fastify/static's internal route registrations), so requests
  // to backoffice.run-far.cc get apps/backoffice/dist and every other host (the custom
  // domain, Railway's internal domain, localhost) falls through to apps/web/dist. Only the
  // web plugin decorates `reply.sendFile` (decorateReply:false on the other one avoids a
  // duplicate-decorator error); the shared notFoundHandler below picks the right root by
  // passing it explicitly as sendFile's second argument.
  const isApiOrHealthPath = (url: string) =>
    url.startsWith("/api") || url.startsWith("/webhooks") || url.startsWith("/health");

  const backofficeDist = env.NODE_ENV === "production" ? distPath("backoffice") : null;
  if (backofficeDist) {
    await app.register(fastifyStatic, {
      root: backofficeDist,
      wildcard: false,
      decorateReply: false,
      constraints: { host: env.BACKOFFICE_HOSTNAME },
    });
    logger.info({ backofficeDist, host: env.BACKOFFICE_HOSTNAME }, "serving backoffice SPA");
  }

  const webDist = env.NODE_ENV === "production" ? distPath("web") : null;
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
    });
    logger.info({ webDist }, "serving web SPA");
  }

  if (webDist || backofficeDist) {
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split("?")[0] ?? "";
      if (isApiOrHealthPath(url)) {
        reply.status(404).send({
          error: { message: "Not found", code: "NOT_FOUND" },
        });
        return;
      }
      if (backofficeDist && request.headers.host === env.BACKOFFICE_HOSTNAME) {
        return reply.sendFile("index.html", backofficeDist);
      }
      if (webDist) return reply.sendFile("index.html");
      reply.status(404).send({ error: { message: "Not found", code: "NOT_FOUND" } });
    });
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
    // After migrations, so a fresh database has the users table to reconcile against.
    await reconcileAdminEmails();
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
