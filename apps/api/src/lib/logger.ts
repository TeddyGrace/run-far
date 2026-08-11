import pino from "pino";
import { env } from "../env.js";

export const logger = pino(
  env.NODE_ENV === "development"
    ? { level: "debug", transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: "info" },
);
