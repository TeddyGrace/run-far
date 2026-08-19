import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

// Load the repo-root .env regardless of the process's cwd (pnpm --filter runs
// commands with apps/api as cwd, not the repo root).
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });

/**
 * Platform dashboards make it easy to set a variable to an empty string or to a bare
 * hostname (e.g. a `RAILWAY_PUBLIC_DOMAIN` reference). Drop blanks so schema defaults
 * apply, and add the scheme so origins parse as URLs.
 */
function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function isLoopback(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Public site origin (SPA + API when hosted together on Railway). */
const webOrigin =
  normalizeOrigin(process.env.WEB_ORIGIN) ??
  normalizeOrigin(process.env.RAILWAY_PUBLIC_DOMAIN) ??
  "http://localhost:5174";

/**
 * API origin for OAuth callback URLs. A hosted deploy serves the SPA and `/api` from one
 * host, so a custom domain in WEB_ORIGIN has to drive the callbacks too — otherwise the
 * provider returns the browser to the platform domain, where the `state` cookie set on the
 * custom domain isn't sent and every sign-in fails the CSRF check. Local dev is the one
 * split-host case: Vite serves the SPA on 5174 and proxies `/api` to the API on 8787.
 */
const apiOrigin = isLoopback(webOrigin) ? "http://localhost:8787" : webOrigin;

const rawEnv = {
  ...process.env,
  PORT: process.env.PORT?.trim() || undefined,
  API_PORT: process.env.API_PORT?.trim() || undefined,
  WEB_ORIGIN: normalizeOrigin(process.env.WEB_ORIGIN),
  WHOOP_REDIRECT_URI: process.env.WHOOP_REDIRECT_URI?.trim() || undefined,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI?.trim() || undefined,
  GOOGLE_AUTH_REDIRECT_URI: process.env.GOOGLE_AUTH_REDIRECT_URI?.trim() || undefined,
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Railway sets PORT; API_PORT remains the local-dev default.
  API_PORT: z.coerce.number().int().positive().default(8787),
  PORT: z.coerce.number().int().positive().optional(),
  WEB_ORIGIN: z.string().url().default(webOrigin),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (base64, 32 bytes)"),

  WHOOP_CLIENT_ID: z.string().default(""),
  WHOOP_CLIENT_SECRET: z.string().default(""),
  WHOOP_REDIRECT_URI: z.string().default(`${apiOrigin}/api/whoop/oauth/callback`),
  WHOOP_WEBHOOK_SECRET: z.string().default(""),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().default(`${apiOrigin}/api/google/oauth/callback`),
  GOOGLE_AUTH_REDIRECT_URI: z.string().default(`${apiOrigin}/api/auth/google/callback`),
  GOOGLE_WEBHOOK_URL: z.string().default(""),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  // Comma-separated allowlist gating account CREATION (not existing users). Empty allows
  // anyone to sign up in development, but fails closed (denies everyone) in production, so a
  // deploy that forgets to set it doesn't accidentally open public signup.
  ALLOWED_EMAILS: z.string().default(""),
  /** IANA timezone for scheduling planned runs (wall-clock times the athlete sees). */
  ATHLETE_TIMEZONE: z.string().default("America/New_York"),
  /** Contact NWS shows to the app operator (not the athlete) in the API's User-Agent header. */
  NWS_CONTACT_EMAIL: z.string().default("teddygrace77@gmail.com"),
  /** Widens the session cookie to this domain (e.g. ".run-far.cc") so a login on the main
   * site is also valid on the backoffice subdomain. Left unset in dev — a host-only cookie
   * on "localhost" is already sent to every port, so no sharing trick is needed there. */
  COOKIE_DOMAIN: z.string().default(""),
  /** Host the backoffice SPA is served on — see server.ts host-constrained static serving. */
  BACKOFFICE_HOSTNAME: z.string().default("backoffice.run-far.cc"),
});

const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  // Names safe to echo back: knowing the bad value is what makes the error actionable.
  const printable = new Set(["WEB_ORIGIN", "PORT", "API_PORT", "NODE_ENV"]);
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".");
    const received = printable.has(key)
      ? ` (received: ${JSON.stringify(process.env[key] ?? null)})`
      : "";
    console.error(`  - ${key}: ${issue.message}${received}`);
  }
  console.error("Copy .env.example to .env and fill in the required values.");
  process.exit(1);
}

const data = parsed.data;

const allowedEmails = new Set(
  data.ALLOWED_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export const env = {
  ...data,
  GOOGLE_WEBHOOK_URL:
    data.GOOGLE_WEBHOOK_URL ||
    (isLoopback(data.WEB_ORIGIN) ? "" : `${data.WEB_ORIGIN}/webhooks/google`),
  /** Prefer Railway's PORT when present. */
  listenPort: data.PORT ?? data.API_PORT,
  /** Empty set means "allow all" outside production, "deny all" in production — see
   * findOrCreateGoogleUser (routes/auth.ts), the only place this gates account creation. */
  allowedEmails,
};
