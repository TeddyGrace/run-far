# run-far

**A running training-log and recovery assistant.** It pulls recovery/sleep
data from Whoop, imports a training plan from TrainingPeaks (or has Claude
build one from a conversation), keeps it two-way synced with Google Calendar,
and runs a deterministic rules engine that proposes schedule changes when
today's recovery doesn't match what the plan expects.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-C5F74F?logoColor=black)
![Anthropic](https://img.shields.io/badge/Claude_API-D97757?logoColor=white)

<!--
  A screenshot or short GIF of the Dashboard / drag-and-drop Calendar goes
  well here — this is the highest-value slot on the page for a visual.
  ![dashboard](docs/dashboard.png)
-->

## What it does

- **Recovery-aware scheduling** — reads Whoop recovery, HRV, sleep, and
  strain data and compares it against the active plan; a rules engine
  proposes concrete edits (downgrade a hard session, push a session out a
  day, swap it with an easy one) rather than just flagging a problem. Rules
  are arbitrated down to one card per run, so no two suggestions can propose
  conflicting edits to the same session.
- **Two-way Google Calendar sync** — a dedicated "Running" calendar mirrors
  the app's planned runs, with loop-prevention and app-wins conflict
  resolution when both sides changed.
- **Calendar-aware conflict detection** — checks planned runs against real,
  timed commitments on the athlete's primary calendar (declined invites,
  all-day events, and "Free"-marked events are filtered out) and proposes
  the nearest open slot.
- **Planned vs. actual reconciliation** — matches the workouts Whoop synced
  against the sessions the plan asked for, so the app can say whether the
  plan is actually being followed rather than only what was intended. Runs
  reconcile to completed or missed on their own, and the athlete can correct
  a match the heuristic got wrong.
- **AI-assisted planning** — describe a training block in a multi-turn chat
  with Claude and get back a structured plan to preview and commit, or ask
  the assistant questions about your schedule.

## Engineering highlights

- **Two-way calendar sync with conflict resolution** — inbound and outbound
  Google Calendar sync avoid update loops via a sync-origin marker, and when
  both the app and Google changed the same run since the last sync, the
  app's version wins and the overwrite is logged to `sync_conflicts` for
  auditability.
  → [`apps/api/src/integrations/google/pull.ts`](apps/api/src/integrations/google/pull.ts),
  [`push.ts`](apps/api/src/integrations/google/push.ts)
- **Pure, unit-testable rules engine** — every recommendation rule is a
  synchronous, side-effect-free function of one input snapshot; all I/O
  (building the snapshot, fetching calendar events) happens once, upstream,
  which is what makes each rule trivially fixture-testable.
  → [`apps/api/src/recommendations/`](apps/api/src/recommendations/)
- **Idempotent under real concurrency** — a partial unique index plus
  `onConflictDoUpdate` makes regeneration safe when a Whoop webhook, the
  nightly sync, and a dashboard read all race to write the same
  recommendation; a content fingerprint (independent of array ordering and
  the calendar day) makes dismissal permanent instead of racing the next
  regeneration.
  → [`apps/api/src/db/schema.ts`](apps/api/src/db/schema.ts),
  [`recommendations/service.ts`](apps/api/src/recommendations/service.ts)
- **Pluggable recommendation sources with a shadow mode** — the rules engine
  is one implementation of a `RecommendationSource` interface, so a
  machine-learned model can later run beside it, instead of it, or silently
  against it. Every card is persisted with the source that produced it, next
  to the input snapshot it was generated from and the athlete's eventual
  accept/dismiss — a features → action → outcome record a candidate model can
  be scored on before it is ever shown to anyone. Rendered sources are
  arbitrated together so at most one card can touch a given run; shadow
  sources are arbitrated alone, which is what makes them structurally unable
  to change what the athlete sees. Rules win ties at `red` severity, so the
  deterministic recovery override stays authoritative regardless of model
  output.
  → [`apps/api/src/recommendations/sources/`](apps/api/src/recommendations/sources/),
  [`recommendations/service.ts`](apps/api/src/recommendations/service.ts)
- **A faithful training record, not just the cards that were clicked** — the
  outcome a recommendation most often has is that nobody acts on it and the
  situation passes. That used to be a hard `DELETE`, so the retained data
  skewed toward the minority of cards someone clicked. Retraction now writes a
  terminal `expired` status instead, `stale` is split out from `dismissed` so
  "the athlete accepted, but the run had moved on" stops looking like a
  rejection, each card snapshots the runs it targets and the calendar windows
  that motivated it, and the GET route stamps `first_shown_at` so "never seen"
  is distinguishable from "seen and ignored". All four are unrecoverable after
  the fact, which is why they landed before the model rather than after.
  → [`recommendations/trainingContext.ts`](apps/api/src/recommendations/trainingContext.ts),
  [`recommendations/service.ts`](apps/api/src/recommendations/service.ts)
- **Closing the loop between the plan and what was run** — `planned_runs`
  carried a `completed` status from the first migration that nothing ever
  wrote: the plan and the workouts synced from Whoop were parallel tables
  that never touched, so the app could show what was intended and what
  happened but never that they were the same session. A reconciliation sweep
  now links them. The matcher is pure and conservative — run sports only,
  same athlete-local day, time-of-day used only to rank candidates within a
  day and never to rescue one across a boundary — because a wrong link
  silently corrupts both the adherence figure and the outcome attached to a
  recommendation. The sweep is re-derivable rather than incremental: it
  clears its own prior guesses inside the window and re-decides from current
  data, so a late sync, a re-score, or a deleted workout all converge. What
  the athlete corrects by hand is stamped `manual` and never revisited, and
  that correction is itself a labelled example of a case the heuristic
  missed. It deliberately leaves `updated_at` alone — that column is what
  Google's inbound sync reads as "the app changed this run", and a
  background pass bumping it would turn every inbound calendar edit into a
  false conflict.
  → [`apps/api/src/reconciliation/`](apps/api/src/reconciliation/)
- **Outcomes, not just clicks** — a recommendation's `status` records the
  athlete's verdict on the card and stops there. Whether the athlete who
  accepted "downgrade tomorrow's tempo" actually ran easy, and what their
  recovery looked like the next morning, is the part that says whether the
  advice was any good — and it only becomes knowable once the targeted runs
  reconcile. `outcome_context` is written once at that point and never
  revised, since a label that kept moving would silently change the target
  under any model already scored on it. Cards whose runs never settle are
  recorded at a deadline rather than held forever, so the retained set
  doesn't skew toward the tidy cases.
  → [`recommendations/outcome.ts`](apps/api/src/reconciliation/outcome.ts)
- **Runtime switches, not redeploys** — whether athletes see model-sourced
  recommendations is a backoffice toggle with a global default and per-account
  overrides, resolved in one place. The model runs and is scored either way;
  the switch gates rendering only.
  → [`apps/api/src/lib/modelRendering.ts`](apps/api/src/lib/modelRendering.ts),
  [`apps/backoffice/src/App.tsx`](apps/backoffice/src/App.tsx)
- **Timezone-correct scheduling** — wall-clock math (open-slot search,
  day-boundary detection) goes through small DST-safe conversion helpers
  built on `Intl.DateTimeFormat` rather than a heavyweight date library.
  → [`apps/api/src/lib/zonedTime.ts`](apps/api/src/lib/zonedTime.ts)
- **Encrypted OAuth tokens + single-flight refresh** — tokens are encrypted
  at rest with AES-256-GCM, and concurrent requests against an
  about-to-expire access token trigger exactly one refresh, not one per
  request.
  → [`apps/api/src/lib/crypto.ts`](apps/api/src/lib/crypto.ts),
  [`integrations/whoop/client.ts`](apps/api/src/integrations/whoop/client.ts)
- **Shared, validated contract** — `packages/shared` is a set of Zod schemas
  imported by both the Fastify API and the Vite SPA, so request/response
  shapes can't silently drift between client and server.
  → [`packages/shared/`](packages/shared/)
- **LLM tool-use integration** — the plan-builder and assistant chats use
  Claude with structured tool calls (propose a plan, shift run times, read
  calendar events) rather than free-text parsing.
  → [`apps/api/src/integrations/anthropic/`](apps/api/src/integrations/anthropic/)

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
shapes can't drift silently. Data flows one way in: Whoop and TrainingPeaks
data land in Postgres, the rules engine reads a snapshot of it, and
proposed changes are applied back to `planned_runs` (then pushed out to
Google) only when the athlete accepts them.

## Quickstart

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

Postgres 16, either:

- **Docker**: `docker compose up -d` (uses `docker-compose.yml`)
- **Homebrew, no Docker**: `pnpm db:start` (wraps `scripts/pg.sh`, a local
  `pg_ctl`-managed instance under `.pgdata/`). Stop it with `pnpm db:stop`.

Then:

```bash
pnpm db:migrate   # apply the schema
pnpm db:seed      # a fake week of recovery data + planned runs, so the UI
                  # is usable before any integration is connected
pnpm dev          # runs apps/api on :8787 and apps/web on :5174 in parallel
```

Open `http://localhost:5174` and sign in with the seeded account:
`dev@run-far.local` / `devpassword123`.

## Testing

```bash
pnpm test        # all packages
pnpm typecheck   # all packages
```

Coverage as of this writing:
- Rules engine (`recommendations/evaluate.test.ts`) — one fixture per rule,
  plus severity ordering, actionable-before-advisory ranking, today-only
  targeting, timezone-correct scheduling, all-day/rest-run exclusion, and the
  "nothing fires" case.
- Rule arbitration (`recommendations/arbitrate.test.ts`) — when several rules
  want to change the same run, one card owns it and the rest are folded into
  its reason; advisory rules pass through untouched.
- Recommendation sources (`recommendations/sources/sources.test.ts`) — the
  rules adapter matches `evaluate()` exactly, a model source that throws or
  hangs fails open to no output rather than an empty dashboard, and the rules
  source is deliberately *not* caught so a broken engine can't read as "no
  recommendations today".
- Source isolation (`recommendations/service.sources.test.ts`) — a shadow card
  cannot claim a run or edit a rendered card's reason, shadow rows survive the
  dashboard reads that regenerate only the rules engine, and two sources
  emitting the same rule id get a row each instead of clobbering one another.
- Shadow unreachability (`routes/recommendations.sources.test.ts`) — shadow
  rows are absent from the pending list and 404 on both accept and dismiss, so
  an engine that is switched off can never edit a real session.
- Training-record capture (`recommendations/trainingRecord.test.ts`) — a rule
  that stops firing leaves an `expired` row with `applied_at` set rather than a
  missing row; that row is absent from the dashboard, the digest email and the
  pending query; an expired card may fire again immediately while an
  accepted/dismissed one stays suppressed inside the 14-day window; an expired
  row and a fresh pending row coexist for the same `(user, source, rule)`
  without violating the pending-only unique index; and `first_shown_at` is null
  until the first GET, then stamped once and not re-stamped.
- Decision context (`recommendations/trainingContext.test.ts`) — target-run
  projection across several changes to different runs, advisory cards yielding
  empty arrays, only overlapping busy windows captured, and calendar event
  titles never appearing in the output.
- Stale vs. dismissed (`routes/recommendations.stale.test.ts`) — accepting a
  card whose every change was overtaken returns 409 `STALE_RECOMMENDATION` and
  writes `stale`; an actual dismissal still writes `dismissed`.
- Stale-proposal detection (`recommendations/staleness.test.ts`) — a proposed
  change whose run has been edited since the card was generated is skipped
  rather than overwriting the athlete's edit.
- Workout matching (`reconciliation/match.test.ts`) — same-day matching across
  the whole day rather than a window around the planned time, no matching
  across a day boundary, bucketing in the athlete's zone rather than UTC,
  non-run sports and rest days excluded, one workout to at most one run on a
  double day, timed candidates beating untimed ones, and a result that is a
  function of its inputs rather than of row order.
- Reconciliation sweep (`reconciliation/reconcile.test.ts`) — idempotence, a
  deleted workout un-completing the run it satisfied, a workout reassigning
  between runs without tripping the one-workout-one-run index, today's
  unmatched run staying undecided instead of being called missed, a dormant
  plan's runs not competing for the live plan's workouts, `updated_at` left
  untouched so Google's conflict detection still works, manual corrections
  surviving every later pass and withholding their workout from other runs,
  the adherence figures themselves, and outcome capture (written once, never
  revised, advisory cards included, a deleted target run still recorded).
- Timezone helpers (`lib/zonedTime.test.ts`) — wall-clock conversion, and
  `addLocalDays` preserving the athlete's clock time across both DST boundaries.
- Recommendation fingerprinting (`recommendations/fingerprint.test.ts`) —
  stability across key/array ordering, sensitivity to real content changes.
- Calendar event filtering (`integrations/google/calendarClient.test.ts`) —
  all-day, cancelled, declined, and "Free"-marked events are excluded from
  conflict detection.
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
candidates for `nock`-style HTTP-mocked tests if this grows further.

A pre-commit hook (`.githooks/pre-commit`) warns — but doesn't block — when
`apps/api/src`, `apps/web/src`, `packages/shared/src`, or a migration
changes without a matching `README.md` update, so this document doesn't
drift too far from what's actually built. Skip it for one commit with
`SKIP_README_CHECK=1 git commit ...`.

<details>
<summary><strong>Registering the OAuth apps (Whoop + Google)</strong></summary>

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
   (internal is fine if you're the only user; use External + a test-user
   allowlist, or verify the app, once you're inviting others). Add the
   scopes `openid`, `email`, `profile`, and
   `https://www.googleapis.com/auth/calendar`.
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

</details>

<details>
<summary><strong>Training plans (Build)</strong></summary>

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

</details>

<details>
<summary><strong>Deploy on Railway (API + web + Postgres)</strong></summary>

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
   On a custom domain, set `WEB_ORIGIN` and the redirect URIs follow it automatically.

5. Deploy. Health check is `GET /health`. Migrations run on boot (`start:prod`).
6. In Whoop + Google consoles, add the prod redirect/webhook URLs, e.g.:
   - `https://<app>.up.railway.app/api/auth/google/callback`
   - `https://<app>.up.railway.app/api/whoop/oauth/callback`
   - `https://<app>.up.railway.app/webhooks/whoop`
   - `https://<app>.up.railway.app/webhooks/google`
7. Create your first user: either Sign in with Google, or run a one-off
   `pnpm db:seed` against prod (only if you want the local seed account).

Custom domain: add it in Railway, set `WEB_ORIGIN=https://your.domain`, and register the
callback + webhook URLs above under that domain in the Whoop/Google consoles. The redirect
URI variables derive from `WEB_ORIGIN`, so only override them to point somewhere else.
Serve the domain over end-to-end HTTPS (Cloudflare SSL mode Full/Full-strict, not Flexible)
— the session cookie is `Secure`. Pick one canonical host: if both the apex and `www`
resolve, redirect one to the other, since a session started on one isn't sent to the other.

Local Docker smoke-test (optional):

```bash
docker build -t run-far .
docker run --rm -p 8080:8080 --env-file .env -e NODE_ENV=production -e PORT=8080 run-far
```

</details>

<details>
<summary><strong>Notes on state</strong></summary>

- Multi-user via Google sign-in (`/api/auth/google/*`) — account creation is
  gated by `ALLOWED_EMAILS` (comma-separated allowlist; empty allows anyone in
  development but denies everyone in production, so a deploy that forgets to
  set it fails closed). Existing accounts can also add an email+password via
  Settings → Email sign-in. The seed script (`db:seed`) remains the fastest
  way to get a local dev user without going through OAuth.
- Each user has their own IANA timezone (`users.timezone`, captured from the
  browser at login — see `apps/api/src/lib/athleteTimezone.ts`), own Whoop
  and Google connections, and fully isolated data; `ATHLETE_TIMEZONE` /
  `ATHLETE_LAT` / `ATHLETE_LON` in `.env` are only fallbacks for users who
  haven't set their own.
- The app DB is the source of truth for planned runs; Google Calendar
  mirrors it. On a conflict (both sides changed since the last sync), the
  app's version always wins and the overwrite is logged to `sync_conflicts`.
- OAuth tokens are encrypted at rest (`apps/api/src/lib/crypto.ts`); nothing
  else in the codebase should ever see plaintext tokens.

</details>

## Data notes for the recommendations training set

Each `recommendations` row is a features → action → outcome record: the
athlete's physiology at decision time (`input_snapshot`), the world outside it
(`decision_context`), the suggestion (`proposed_changes`), what the athlete did
with it (`status`, `first_shown_at`, `applied_at`), and what actually happened
afterwards (`outcome_context`). Read these caveats before training on it.

**Status meanings.** `pending` is unresolved. `accepted` and `dismissed` are
athlete verdicts. `expired` means the producing rule stopped firing while the
card was still pending — the athlete never resolved it. `stale` means the
athlete tried to accept but every proposed change had been overtaken by an edit
to the run. `applied_at` is set on all four terminal transitions, so
`applied_at - created_at` is time-to-decision; the column name predates that
broader meaning.

**Cutover: 2026-09-08.** Before this date, `expired` and `stale` did not exist.
Retracted cards were hard-deleted and are simply absent — that period's data
over-represents cards someone acted on, and the absences cannot be
reconstructed. `dismissed` rows from before the cutover are a mix of real
dismissals and what would now be `stale`, so either exclude pre-cutover
dismissals or treat them as a noisier class. `decision_context` and
`first_shown_at` are null on pre-cutover rows.

**`first_shown_at` is what makes an expired row interpretable.** Null means the
card was never rendered to the athlete — not a training example at all. Non-null
on an expired row means it was shown and not acted on, which is a real negative.

**`outcome_context` is the consequence, not the click.** `status` says what the
athlete did with the card; `outcome_context` says what became of the sessions it
was about — for each targeted run, whether it was executed and how the session
that happened compared to the one planned, plus the next morning's recovery. It
is written once by the reconciliation sweep after the targeted runs settle, and
never revised: a label that kept being recomputed would silently change the
target under any model already scored on it. Advisory cards that propose no
change still get a row, since next-day recovery is a real outcome for them too.
Check `complete` before training on one — false means a targeted run was still
undecided when the deadline forced the record out, or was deleted before it could
reconcile, which is missing data rather than a missed session. Null means the
card is still pending, its runs have not settled, or it resolved before the
column existed (see the cutover note above; `outcome_context` landed with the
reconciliation sweep, later than `decision_context`).

**Reconciliation is a heuristic, and `planned_runs.match_source` says whose.**
`auto` is the matcher's own guess — run sports, same athlete-local day, nearest
start time — and it is re-derived on every sweep. `manual` is the athlete
overriding it, and those rows are worth treating as a distinct, higher-confidence
class: each one is also a labelled example of a pairing the heuristic would not
make on its own (most often a session run a day later than planned). A run with
`reconciled_at` set and no `actual_workout_id` was examined and genuinely
matched nothing; a null `reconciled_at` means no pass has reached it, which is
not the same thing.

**`decision_context` deliberately omits calendar event titles.** Busy windows
are recorded as bare `{start, end}` pairs. Event names are personal data from a
third-party account pulled in for a transient scheduling decision, and copying
them into a long-lived table changes both what that data is for and how long it
lives. The overlap window is the part a model can learn from.

Known limits this record still has:

- **In-place supersede loses history.** The pending upsert overwrites a row when
  a card's content changes, so if an athlete saw version A and then version B,
  only B survives. Capturing every version would be mostly noise — the upsert
  rewrites on every dashboard read — so the honest fix is fingerprint-triggered
  versioning, deferred until there is a reason to want it.
- **Flapping rules inflate row count.** A rule oscillating around a threshold
  now mints a pending row and an expired row per cycle instead of silently
  churning one row. Worth watching row growth; the existing
  `(user_id, source, status)` index covers the queries.
- **No retention policy.** Expired rows accumulate deliberately — they are the
  asset. Revisit only if volume becomes a problem.
- **Matching is greedy, not optimal.** On a double day where two planned runs and
  two workouts pair up crosswise, the nearest-first assignment can get both
  backwards. Optimal assignment would fix it at roughly five times the code; a
  wrong link costs the athlete one click to correct, and the correction is
  recorded. Revisit if double days turn out to be common.
- **`outcome_context` reads next-day recovery, not a controlled comparison.**
  Recovery the morning after is confounded by everything else the athlete did
  that day. It is a signal, not an effect estimate.
