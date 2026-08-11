import type { CookieSerializeOptions } from "@fastify/cookie";
import { env } from "../env.js";

/** Shared cookie flags for session + OAuth state. Secure in production (HTTPS). */
export function cookieOpts(
  overrides: CookieSerializeOptions = {},
): CookieSerializeOptions {
  return {
    path: "/",
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    httpOnly: true,
    ...overrides,
  };
}
