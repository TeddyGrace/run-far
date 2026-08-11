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
pnpm dev          # runs apps/api on :8787 and apps/web on :5173 in parallel
```

Open `http://localhost:5173` and sign in with the seeded account:
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

### Google Calendar

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com),
   enable the **Google Calendar API**, and configure an OAuth consent screen
   (internal is fine for a single-user app).
2. Create an OAuth 2.0 Client ID (type: Web application). Add
   `GOOGLE_REDIRECT_URI` (`http://localhost:8787/api/google/oauth/callback`
   for local dev) as an authorized redirect URI.
3. Copy the client id/secret into `.env`.
4. On first connect, the app creates a dedicated **"Running"** calendar —
   it never writes to your primary calendar.
5. Push notifications (`events.watch`) require a public HTTPS URL. Set
   `GOOGLE_WEBHOOK_URL` to a tunnel URL pointing at `/webhooks/google` if you
   want instant sync in dev. Without it, sync still works via the manual
   "Sync now" button on the Settings page and the periodic channel-renewal
   job's fallback pulls.

## TrainingPeaks import

There's no personal API for TrainingPeaks — plans come in as a CSV export
(Settings → Import, or the Import page directly). Uploading previews parsed
rows with warnings before anything is committed to the calendar; re-uploading
the same file updates existing runs instead of duplicating them.

TrainingPeaks' exported column headers vary by export type and account
tier. The parser (`apps/api/src/integrations/trainingpeaks/columnAliases.ts`)
maps a table of known header aliases rather than fixed column indices — if a
real export doesn't parse cleanly, that alias table is almost certainly the
only thing that needs updating.

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
