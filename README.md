# run-far

A running and calendar assistant: a dashboard of your Whoop recovery, a
manipulable calendar of planned runs imported from TrainingPeaks, and a rules
engine that proposes schedule changes when today's recovery doesn't match
what the plan expects. Two-way sync with Google Calendar keeps a dedicated
"Running" calendar in step with the app.

## Architecture

```
apps/
  web/          Vite + React + TypeScript + Tailwind + TanStack Query + dnd-kit
  api/          Fastify + TypeScript + Drizzle ORM → Postgres
packages/
  shared/       Zod schemas + inferred types shared by web and api
```

`packages/shared` is the contract between the two apps — every API route
validates with the same Zod schema the SPA imports, so request/response
shapes can't drift silently.

## Prerequisites

- Node.js 20+, pnpm (`corepack enable` or `npm i -g pnpm`)
- Postgres 16. Either:
  - **Docker**: `docker compose up -d` (uses `docker-compose.yml`)
  - **Homebrew, no Docker**: `pnpm db:start` (wraps `scripts/pg.sh`, a local
    `pg_ctl`-managed instance under `.pgdata/`). Stop it with `pnpm db:stop`.

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:

- `SESSION_SECRET` — any long random string.
- `ENCRYPTION_KEY` — a base64-encoded 32-byte key used to encrypt OAuth
  tokens at rest (AES-256-GCM). Generate one with `openssl rand -base64 32`.
- Whoop and Google credentials — see below. The app runs without them; you
  just won't be able to connect those integrations until they're set.

Then:

```bash
pnpm db:migrate   # apply the schema
pnpm db:seed      # a fake week of recovery data + planned runs, so the UI
                  # is usable before any integration is connected
pnpm dev          # runs apps/api on :8787 and apps/web on :5174 in parallel
```

Open `http://localhost:5174` and sign in with the seeded account:
`dev@run-far.local` / `devpassword123`.

## Registering the OAuth apps

Neither of these can be scripted — both require clicking through a
provider's own developer console.

### Whoop

1. Go to the [Whoop Developer Dashboard](https://developer.whoop.com) and
   create an app.
2. Set the redirect URI to match `WHOOP_REDIRECT_URI` in `.env`
   (`http://localhost:8787/api/whoop/oauth/callback` for local dev).
3. Request scopes: `offline read:profile read:body_measurement read:cycles
   read:recovery read:sleep read:workout`.
4. Copy the client id/secret into `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET`.
5. `WHOOP_WEBHOOK_SECRET` is the same value as your client secret — Whoop
   signs webhook payloads with it.
6. Webhooks need a public HTTPS URL (`https://developer.whoop.com` → your
   app → webhook URL). In dev, run a tunnel (`cloudflared tunnel --url
   http://localhost:8787` or `ngrok http 8787`) and point it at
   `/webhooks/whoop`. Without a tunnel, the nightly sync job
   (`startWhoopNightlySync`) is the fallback — recovery data just lags by up
   to a day instead of arriving instantly.

Once connected (Settings → Whoop → Connect), the app backfills 90 days of
recovery, sleep, and workout data automatically.

### Google (Sign-In + Calendar)

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com),
   enable the **Google Calendar API**, and configure an OAuth consent screen
   (internal is fine for a single-user app). Add the scopes `openid`, `email`,
   `profile`, and `https://www.googleapis.com/auth/calendar`.
2. Create an OAuth 2.0 Client ID (type: Web application). Add **both** redirect
   URIs:
   - `GOOGLE_AUTH_REDIRECT_URI` — `http://localhost:8787/api/auth/google/callback`
     (Sign in with Google on the login screen)
   - `GOOGLE_REDIRECT_URI` — `http://localhost:8787/api/google/oauth/callback`
     (Calendar connect under Settings)
3. Copy the client id/secret into `.env`.
4. On first Calendar connect, the app creates a dedicated **"Running"** calendar —
   it never writes to your primary calendar.
5. Push notifications (`events.watch`) require a public HTTPS URL. Set
   `GOOGLE_WEBHOOK_URL` to a tunnel URL pointing at `/webhooks/google` if you
   want instant sync in dev. Without it, sync still works via the manual
   "Sync now" button on the Settings page and the periodic channel-renewal
   job's fallback pulls.

Signing in with Google is a single consent step: it creates (or links) the user
and grants Calendar access at the same time, then creates the Running calendar
and pulls existing events in the background. The Settings → Google card is only
needed to repair a revoked connection. Email/password login remains available as
a fallback for the seeded local account.

## Training plans (Build)

The **Build** tab manages training plans. Only one plan can be **active** at a
time — its runs appear on the Dashboard, Calendar, and Google Calendar. Activating
another plan (or committing a new import / AI plan) removes the previous active
plan's calendar events. Plans can be archived without deleting them.

Two ways to add a plan:

1. **Import CSV** — TrainingPeaks export. Uploading previews parsed rows with
   warnings before commit.
2. **Describe your own** — multi-turn chat with Anthropic that proposes a plan;
   you preview and confirm before it becomes active. Requires `ANTHROPIC_API_KEY`.

TrainingPeaks' exported column headers vary by export type and account
tier. The parser (`apps/api/src/integrations/trainingpeaks/columnAliases.ts`)
maps a table of known header aliases rather than fixed column indices — if a
real export doesn't parse cleanly, that alias table is almost certainly the
only thing that needs updating.

## Deploy on Railway (API + web + Postgres)

One Docker service serves the Fastify API and the Vite SPA on the same origin
(so `/api` cookie auth works without CORS tricks). Postgres is a Railway plugin.

1. Push this repo to GitHub (if it isn't already).
2. In [Railway](https://railway.app): **New Project → Deploy from GitHub** → pick this repo.
3. **Add Postgres** (plugin) and **connect** it to the service so `DATABASE_URL` is set.
4. Set variables on the service:

   | Variable | Notes |
   |---|---|
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | long random string |
   | `ENCRYPTION_KEY` | `openssl rand -base64 32` |
   | `WHOOP_CLIENT_ID` / `SECRET` / `WEBHOOK_SECRET` | from Whoop dashboard |
   | `GOOGLE_CLIENT_ID` / `SECRET` | from GCP |
   | `ANTHROPIC_API_KEY` | optional, for Build → Describe |

   Leave `WEB_ORIGIN` and OAuth redirect URIs unset unless you use a custom domain —
   they default from `RAILWAY_PUBLIC_DOMAIN` (`https://<your-app>.up.railway.app`).

5. Deploy. Health check is `GET /health`. Migrations run on boot (`start:prod`).
6. In Whoop + Google consoles, add the prod redirect/webhook URLs, e.g.:
   - `https://<app>.up.railway.app/api/auth/google/callback`
   - `https://<app>.up.railway.app/api/whoop/oauth/callback`
   - `https://<app>.up.railway.app/webhooks/whoop`
   - `https://<app>.up.railway.app/webhooks/google`
7. Create your first user: either Sign in with Google, or run a one-off
   `pnpm db:seed` against prod (only if you want the local seed account).

Custom domain: add it in Railway, then set `WEB_ORIGIN=https://your.domain` and
update OAuth redirect URIs to match.

Local Docker smoke-test (optional):

```bash
docker build -t run-far .
docker run --rm -p 8080:8080 --env-file .env -e NODE_ENV=production -e PORT=8080 run-far
```

## Recommendation engine

`apps/api/src/recommendations/` is a pure rules engine: `snapshot.ts` is the
only part that touches the database (building today's recovery snapshot plus
rolling baselines); every rule in `rules/*.ts` is a synchronous, side-effect-free
function of that snapshot. Thresholds live in `config.ts`. See
`apps/api/src/recommendations/evaluate.test.ts` for the fixture-based tests
covering each rule.

## Testing

```bash
pnpm test        # all packages
pnpm typecheck   # all packages
```

Coverage as of this writing:
- Rules engine (`evaluate.test.ts`) — one fixture per rule, plus severity
  ordering and the "nothing fires" case.
- TrainingPeaks CSV parser (`parser.test.ts`) — header aliasing, unit
  normalization, malformed rows.
- Token encryption (`crypto.test.ts`) — round-trip and tamper detection.
- Whoop webhook signature verification (`webhooks.test.ts`) — valid,
  tampered, wrong-secret, and malformed-signature cases.
- Whoop access-token refresh concurrency (`client.test.ts`) — concurrent
  requests against an expiring token trigger exactly one refresh.

Google Calendar's two-way sync loop-prevention and app-wins conflict
resolution (`pull.ts` / `push.ts`) were verified live against a real
Google Calendar during development rather than with mocks — see the
worked example in the original implementation plan. They're reasonable
candidates for `nock`-style HTTP-mocked tests if this grows past a
single-user tool.

## Notes on state

- Single-user by design — session auth, no signup flow. The seed script is
  the only way a user gets created.
- The app DB is the source of truth for planned runs; Google Calendar
  mirrors it. On a conflict (both sides changed since the last sync), the
  app's version always wins and the overwrite is logged to `sync_conflicts`.
- OAuth tokens are encrypted at rest (`apps/api/src/lib/crypto.ts`); nothing
  else in the codebase should ever see plaintext tokens.
