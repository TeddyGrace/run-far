import pino from "pino";
import { env } from "../env.js";

/** Fastify doesn't serialize request bodies by default, so a password can't reach the logs
 * today — this is insurance against a future `log.info({ body })` quietly leaking one. */
const redact = {
  paths: [
    "req.body.password",
    "req.body.currentPassword",
    "req.body.token",
    "password",
    "currentPassword",
    "passwordHash",
    "token",
  ],
  censor: "[REDACTED]",
};

export const logger = pino(
  env.NODE_ENV === "development"
    ? { level: "debug", redact, transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: "info", redact },
);
