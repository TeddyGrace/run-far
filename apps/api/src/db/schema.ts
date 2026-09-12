import {
  pgTable,
  uuid,
  text,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  boolean,
  date,
  uniqueIndex,
  index,
  pgEnum,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Enums ---

export const oauthProviderEnum = pgEnum("oauth_provider", ["whoop", "google"]);
// Where an athlete's recovery/sleep/workout data comes from. Distinct from oauthProviderEnum:
// Whoop is reached by a server-side OAuth token, Apple Health has no cloud API at all and is
// pushed to us by the iOS app from HealthKit on the device — so "apple_health" is a data
// provider that will never appear as an oauth_connections row. Exactly one of these is active
// per athlete at a time (users.active_health_provider); rows from the other are retained but
// not read, because the two providers' metrics are not interchangeable (see hrvMetric below).
export const healthProviderEnum = pgEnum("health_provider", ["whoop", "apple_health"]);
// The union of everything sync_state tracks a watermark for: the OAuth providers plus the
// pushed-from-device one. A separate enum rather than reusing oauthProviderEnum because
// "apple_health" is never a valid oauth_connections.provider.
export const syncProviderEnum = pgEnum("sync_provider", ["whoop", "google", "apple_health"]);
// Which HRV metric a recovery row's hrvRmssdMs column actually holds. Whoop reports RMSSD;
// Apple Watch records SDNN, a different computation over the same beat intervals with its own
// scale and spread. They are NOT interchangeable: mixing them in one baseline produces a mean
// and SD that describe neither, which is why every read is filtered to one provider.
export const hrvMetricEnum = pgEnum("hrv_metric", ["rmssd", "sdnn"]);
// Who produced a recovery score. Whoop ships its own 0-100 score; Apple Health has no
// equivalent, so run-far derives one from HRV/RHR/sleep/respiratory-rate deviation against the
// athlete's own baseline (see integrations/appleHealth/recoveryScore.ts). Persisted so a score
// can never be silently attributed to a wearable that never computed it.
export const recoveryScoreSourceEnum = pgEnum("recovery_score_source", ["provider", "derived"]);
export const scoreStateEnum = pgEnum("score_state", ["SCORED", "PENDING_SCORE", "UNSCORABLE"]);
export const runTypeEnum = pgEnum("run_type", [
  "easy",
  "tempo",
  "interval",
  "long",
  "recovery",
  "race",
  "rest",
]);
export const runStatusEnum = pgEnum("run_status", ["planned", "completed", "skipped", "moved"]);
export const runOriginEnum = pgEnum("run_origin", ["imported", "manual", "recommendation", "ai_generated"]);
// How a planned run came to be linked to (or explicitly divorced from) a Whoop workout.
// "auto" is the reconciliation sweep's own guess and it may revise it on any later pass;
// "manual" is the athlete correcting that guess, and the sweep never overwrites it.
export const runMatchSourceEnum = pgEnum("run_match_source", ["auto", "manual"]);
export const planStatusEnum = pgEnum("plan_status", ["active", "inactive", "archived"]);
export const recommendationSeverityEnum = pgEnum("recommendation_severity", [
  "info",
  "yellow",
  "red",
]);
// "expired" and "stale" are terminal statuses that no athlete action produces — they record
// outcomes that used to leave no trace at all. "expired": the producing rule stopped firing
// while the card was still pending, so the athlete never resolved it (previously the row was
// hard-deleted, discarding the most common outcome the engine has). "stale": the athlete tried
// to accept, but every proposed change had been overtaken by an edit to the run — previously
// written as "dismissed", which made that column mean two different things.
export const recommendationStatusEnum = pgEnum("recommendation_status", [
  "pending",
  "accepted",
  "dismissed",
  "expired",
  "stale",
]);
export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);
export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const accessRequestStatusEnum = pgEnum("access_request_status", [
  "pending",
  "invited",
  "dismissed",
]);
export const signupSourceEnum = pgEnum("signup_source", ["google", "password"]);
export const authTokenPurposeEnum = pgEnum("auth_token_purpose", [
  "email_verification",
  "password_reset",
]);
export const entitlementSourceEnum = pgEnum("entitlement_source", ["comp", "stripe", "apple"]);
// "none" is the default for a brand-new account — distinct from "canceled" (had access, lost
// it) so the backoffice and analytics can tell a never-subscribed user from a churned one.
export const entitlementStatusEnum = pgEnum("entitlement_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "none",
]);
export const aiSurfaceEnum = pgEnum("ai_surface", ["plan_builder", "assistant"]);

// --- Core ---

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    // Null for Google-only accounts; password login still works when set (e.g. seed user).
    passwordHash: text("password_hash"),
    // Stable Google subject from the ID token — preferred lookup over email.
    googleSub: text("google_sub"),
    // Gates the backoffice admin API/UI — see lib/adminAuth.ts. Set by data migration, not
    // editable through any app route.
    role: userRoleEnum("role").notNull().default("user"),
    // Non-null revokes access without destroying data: blocks both sign-in paths and kills
    // any live session on the next request (see lib/activeUser.ts). Reversible from the
    // backoffice — the irreversible option is deleting the row outright.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    // Null until the emailed verification link is used (or, for Google sign-ins, Google's
    // own email_verified assertion). Gates nothing by itself — entitlement is the real gate
    // (lib/entitlement.ts) — but login rejects an unverified password account so an unowned
    // email can't hold one.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    // Legacy. Once the gate for all /api access; now set unconditionally on every signup and
    // read by nothing but the deprecated `approved` field on /api/auth/me and the admin
    // self-heal in lib/adminBootstrap.ts. Access is decided by lib/entitlement.ts. Safe to
    // drop once no client reads `approved`.
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    // How the account was created — surfaced in the backoffice, not used for authorization.
    signupSource: signupSourceEnum("signup_source").notNull().default("google"),
    // Gates the daily recovery/recommendations digest email to at most one per calendar day.
    lastRecoveryEmailDate: date("last_recovery_email_date"),
    // Throttles the "someone tried a password on your Google-only account" notice (see
    // routes/auth.ts login). Anyone who knows an address can trigger that email by failing a
    // login, so it goes out at most once a day per account — enough to tell a stuck owner
    // why their password isn't working, not enough to mailbomb them.
    lastPasswordLoginNoticeAt: timestamp("last_password_login_notice_at", { withTimezone: true }),
    // Null means "use the server default" (env.ANTHROPIC_MODEL) for that agent.
    assistantModel: text("assistant_model"),
    planModel: text("plan_model"),
    // Per-athlete override for whether model-sourced recommendations are *rendered* to them.
    // Null means inherit appSettings.modelRenderedDefault — same null-means-server-default
    // convention as the two model columns above. Never read directly: resolve it through
    // lib/modelRendering.ts. Note this gates rendering only; the model source still runs and is
    // still scored in shadow regardless of what this says.
    modelRenderedOverride: boolean("model_rendered_override"),
    // Which wearable's data the engine reads for this athlete. Never mixed: a Whoop RMSSD
    // baseline and an Apple SDNN baseline describe different quantities, so every recovery /
    // sleep / cycle / workout read is filtered to this one provider. Switching it does not
    // delete the other provider's rows — they stay, unread, and reading resumes if the athlete
    // switches back. Resolve it through lib/healthProvider.ts rather than reading the column.
    activeHealthProvider: healthProviderEnum("active_health_provider").notNull().default("whoop"),
    // Athlete's location for NWS weather lookups, set via Settings (browser geolocation).
    // Null means weather is unavailable — see lib/athleteLocation.ts. locationUpdatedAt is
    // surfaced in Settings ("last set N ago") so a moved athlete notices it's stale and
    // re-clicks "Update location" — there's no background refresh, this is the nudge for it.
    locationLat: doublePrecision("location_lat"),
    locationLon: doublePrecision("location_lon"),
    locationUpdatedAt: timestamp("location_updated_at", { withTimezone: true }),
    // IANA zone captured from the browser at login (see lib/athleteTimezone.ts). Null falls
    // back to env.ATHLETE_TIMEZONE, same pattern as location above.
    timezone: text("timezone"),
    // This athlete's overrides of the rules engine's tunable thresholds — what counts as a red
    // recovery day, how many suppressed HRV days before the engine says something, and so on.
    // Stored sparsely and merged over DEFAULT_RULE_THRESHOLDS: a field absent here means "track
    // the shipped default", so improving a default still reaches everyone who never moved that
    // one. Null (the common case) means no overrides at all. Never read directly — resolve it
    // through lib/ruleThresholds.ts, same convention as modelRenderedOverride above.
    ruleThresholds: jsonb("rule_thresholds"),
    // Null means the new-account tutorial overlay hasn't been completed/skipped yet. Existing
    // accounts are backfilled to non-null at migration time so only new signups see it.
    tutorialCompletedAt: timestamp("tutorial_completed_at", { withTimezone: true }),
    // --- Entitlement (billing) ---
    // Resolved by lib/entitlement.ts, which is the only place that should read these columns
    // to decide access — see activeUserGuard. Null source means the account has never had
    // access (a brand-new signup pre-Stripe). "comp" beats everything else and never expires
    // unless compExpiresAt is set, which is what makes the backoffice comp toggle unconditional
    // regardless of what Stripe thinks is going on for that customer.
    entitlementSource: entitlementSourceEnum("entitlement_source"),
    entitlementStatus: entitlementStatusEnum("entitlement_status").notNull().default("none"),
    // Null means "doesn't expire" (comps with no compExpiresAt); for Stripe-sourced access this
    // mirrors the subscription's current_period_end / trial_end, kept in sync by the Stripe
    // webhook handler only — see integrations/stripe/webhooks.ts.
    entitlementExpiresAt: timestamp("entitlement_expires_at", { withTimezone: true }),
    // Set only when entitlementSource = "comp", by POST /api/admin/users/:id/comp. Mirrors the
    // approvedAt/approvedBy/compNote pattern used for admin-attributed account actions.
    compedAt: timestamp("comped_at", { withTimezone: true }),
    compedBy: uuid("comped_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    compNote: text("comp_note"),
    // Null until the user has started a Stripe Checkout session at least once. Stable once set
    // — see integrations/stripe/webhooks.ts, the only writer.
    stripeCustomerId: text("stripe_customer_id"),
    // Null until the trial/subscription actually starts (Checkout completes). Reused across
    // plan changes (monthly <-> annual) since Stripe treats that as an update, not a new sub.
    stripeSubscriptionId: text("stripe_subscription_id"),
    // The Stripe event `created` timestamp of the last webhook that actually wrote the
    // entitlement columns above — see integrations/stripe/webhooks.ts. Stripe can deliver
    // events out of order (e.g. a retried older `subscription.updated` after a newer one
    // already landed); comparing against this before writing is what stops a stale event
    // from clobbering newer state. Unrelated to `createdAt` on this row.
    entitlementSyncedAt: timestamp("entitlement_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_google_sub_idx").on(t.googleSub),
    // Belt-and-suspenders on top of every write path normalizing through lib/email.ts —
    // catches a case-variant collision (e.g. "Foo@x.com" vs "foo@x.com") that would
    // otherwise slip past the plain unique(email) constraint above.
    uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    uniqueIndex("users_stripe_customer_id_idx").on(t.stripeCustomerId),
    uniqueIndex("users_stripe_subscription_id_idx").on(t.stripeSubscriptionId),
  ],
);

// Tokens are encrypted at rest by apps/api/src/lib/crypto.ts before insert; this table
// never sees plaintext. accessToken/refreshToken columns hold the ciphertext + iv + tag.
export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: oauthProviderEnum("provider").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    // Set true when the provider rejects our refresh token (invalid_grant): the row still
    // exists but is unusable until the user re-consents. hasGoogleConnection() treats a
    // flagged row as disconnected, and re-authorizing clears it. See integrations/google/oauth.ts.
    needsReauth: boolean("needs_reauth").notNull().default(false),
    // Provider-specific bookkeeping, e.g. Google's dedicated "Running" calendarId.
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_connections_user_provider_idx").on(t.userId, t.provider),
    // Routes incoming Whoop webhooks (which only carry the Whoop-side user id, stored in
    // metadata.whoopUserId) back to a connection without a seq scan — see
    // integrations/whoop/webhooks.ts findUserIdForWhoopUser.
    index("oauth_connections_whoop_user_idx")
      .on(sql`(${t.metadata}->>'whoopUserId')`)
      .where(sql`${t.provider} = 'whoop'`),
  ],
);

// --- Weather ---

// NWS daily forecast, one row per (user, calendar date). Read through by
// integrations/weather/forecastStore.ts, which serves these rows while `fetched_at` is inside
// its TTL and refetches from NWS when it isn't — so this table is the cache, not merely a copy
// of one. Rows record no coordinates, which is why a location change deletes them outright
// rather than waiting for them to age out.
export const weatherForecasts = pgTable(
  "weather_forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    highTempF: doublePrecision("high_temp_f"),
    lowTempF: doublePrecision("low_temp_f"),
    shortForecast: text("short_forecast"),
    precipProbabilityPct: doublePrecision("precip_probability_pct"),
    windSpeed: text("wind_speed"),
    windDirection: text("wind_direction"),
    iconUrl: text("icon_url"),
    // Normalized condition glyph key (see WeatherIconCode) driving the frontend's custom SVG
    // icon — decoupled from NWS's own icon URL taxonomy.
    iconCode: text("icon_code"),
    // Per-hour data and derived morning/midday/evening summaries for this date, kept so the
    // frontend and assistant can show intra-day detail without a second live NWS call.
    hourly: jsonb("hourly").notNull().default([]),
    segments: jsonb("segments").notNull().default([]),
    // Active NWS alerts (severity/headline/effective/expires) overlapping this date, kept so
    // the frontend and assistant can show them without a second live NWS call.
    alerts: jsonb("alerts").notNull().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("weather_forecasts_user_date_idx").on(t.userId, t.date)],
);

// --- Wearable data (Whoop, or Apple Health pushed from the iOS app) ---
//
// These four tables are provider-agnostic: each row records which provider it came from and
// that provider's own id for it (`externalId`). Reads are filtered to the athlete's
// activeHealthProvider — see lib/healthProvider.ts for why mixing is never correct.

export const recoveryMetrics = pgTable(
  "recovery_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: healthProviderEnum("provider").notNull().default("whoop"),
    // The provider's own id for the sleep this recovery describes: Whoop's sleep UUID, or the
    // HKCategorySample UUID of the primary sleep Apple Health derived it from.
    externalId: text("external_id").notNull(),
    cycleId: text("cycle_id"),
    date: date("date").notNull(),
    // 0-100. Whoop's own score, or run-far's derived one — recoveryScoreSource says which, and
    // is the only honest way to read this column.
    recoveryScore: doublePrecision("recovery_score"),
    recoveryScoreSource: recoveryScoreSourceEnum("recovery_score_source").notNull().default("provider"),
    // Heart-rate variability in ms. Holds RMSSD for Whoop and SDNN for Apple Health — the
    // column name is kept for the persisted recommendation snapshots that already reference
    // it; hrvMetric is what says which metric the number actually is. Compare a value only
    // against a baseline built from the same provider.
    hrvRmssdMs: doublePrecision("hrv_rmssd_ms"),
    hrvMetric: hrvMetricEnum("hrv_metric").notNull().default("rmssd"),
    restingHr: doublePrecision("resting_hr"),
    spo2: doublePrecision("spo2"),
    // Whoop skin temperature / Apple Watch wrist temperature. Both are a nightly distal
    // temperature; for Apple this is the deviation-friendly absolute value, not Apple's own
    // "wrist temperature deviation" figure, which HealthKit does not expose.
    skinTempC: doublePrecision("skin_temp_c"),
    // Why a derived score came out the way it did: the per-component z-scores and weights the
    // recovery score was built from. Null for provider-scored rows (Whoop shows its own
    // breakdown in its app and we don't recompute it). Purely explanatory — nothing reads it
    // to make a decision, it exists so a surprising score can be accounted for after the fact.
    scoreComponents: jsonb("score_components"),
    scoreState: scoreStateEnum("score_state").notNull().default("PENDING_SCORE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recovery_metrics_provider_external_id_idx").on(t.userId, t.provider, t.externalId),
    index("recovery_metrics_user_provider_date_idx").on(t.userId, t.provider, t.date),
  ],
);

// A physiological cycle — wake-to-wake, can cross midnight, can run longer than 24h. Not a
// calendar day. `end` is null while the cycle is still open/ongoing.
//
// For Whoop this mirrors its own Physiological Cycle, the unit Whoop organizes a member's data
// around; no cycle.* webhooks exist, so those rows are kept fresh by polling and by
// piggybacking on the sleep/recovery webhook handlers. Apple Health has no such concept, so
// for apple_health rows the cycle is *synthesized* from consecutive primary sleeps — a cycle
// runs from one waking to the next (see integrations/appleHealth/cycles.ts). That synthesis is
// what lets everything downstream (the snapshot's "today", the strain/load windows, ACWR) stay
// written against one concept instead of branching per provider.
export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: healthProviderEnum("provider").notNull().default("whoop"),
    // Whoop's numeric cycle id as a string, or for apple_health the deterministic synthetic id
    // "wake-<local date of the waking that starts it>" — deterministic so re-ingesting the same
    // sleeps re-derives the same cycle instead of duplicating it.
    externalId: text("external_id").notNull(),
    start: timestamp("start", { withTimezone: true }).notNull(),
    end: timestamp("end", { withTimezone: true }),
    timezoneOffset: text("timezone_offset"),
    scoreState: scoreStateEnum("score_state").notNull().default("PENDING_SCORE"),
    // Whoop's 0-21 strain score. Always null for apple_health: Apple publishes no strain
    // equivalent and inventing one on a log scale we don't know the shape of would be a
    // fabrication. `kilojoule` is the additive load figure that carries ACWR for both
    // providers — see metrics/cycleMetrics.ts cycleLoad.
    strain: doublePrecision("strain"),
    kilojoule: doublePrecision("kilojoule"),
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cycles_provider_external_id_idx").on(t.userId, t.provider, t.externalId),
    index("cycles_user_provider_start_idx").on(t.userId, t.provider, t.start),
  ],
);

export const sleepRecords = pgTable(
  "sleep_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: healthProviderEnum("provider").notNull().default("whoop"),
    // Whoop's sleep UUID, or the HKCategorySample UUID of the Apple Health sleep session.
    externalId: text("external_id").notNull(),
    cycleId: text("cycle_id"),
    // True for a nap; false for the primary sleep that starts the cycle. Needed to pick the
    // right row when a cycle has both — see buildRecoverySnapshot's sleepDebtMinToday lookup.
    nap: boolean("nap").notNull().default(false),
    date: date("date").notNull(),
    // When the sleep actually began and ended. `date` alone (the local date of waking) is
    // enough to file a night under a day, but not to place a cycle boundary: a cycle runs from
    // one waking to the next, so the *instant* of waking is what decides which cycle a workout
    // falls in. Deriving that instant from the date instead — local midnight, or noon — puts
    // the boundary hours away from the real waking and silently attributes a morning run to the
    // previous cycle. Nullable because rows written before this column existed have no instants
    // to backfill from; Apple Health synthesis falls back to a noon approximation for those and
    // says so at the call site.
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMin: doublePrecision("duration_min"),
    efficiencyPct: doublePrecision("efficiency_pct"),
    // Whoop "Sleep performance" — % of sleep needed that was achieved (the Sleep score).
    performancePct: doublePrecision("performance_pct"),
    // Cumulative, rolling sleep debt in minutes — NEVER re-aggregate this across days (see
    // buildRecoverySnapshot). Whoop reports its own figure. For Apple Health run-far derives it
    // by decaying nightly shortfalls against sleepNeedMin over a trailing window, because
    // HealthKit has no debt concept — see integrations/appleHealth/sleepDebt.ts.
    sleepDebtMin: doublePrecision("sleep_debt_min"),
    // The sleep need the debt above was measured against. Null for Whoop, whose need figure is
    // internal to its own score; populated for derived rows so the debt is auditable rather
    // than an unexplained number.
    sleepNeedMin: doublePrecision("sleep_need_min"),
    respiratoryRate: doublePrecision("respiratory_rate"),
    // Time in bed, distinct from durationMin (asleep). Apple Health reports inBed as its own
    // sample category; efficiencyPct is derived from the two for apple_health rows.
    inBedMin: doublePrecision("in_bed_min"),
    // Per-stage minutes, when the provider breaks sleep down. Apple Watch reports core/deep/REM
    // (mapped to light/deep/rem) plus awake; null when the athlete slept without the watch or
    // only a bare inBed/asleep sample exists.
    lightMin: doublePrecision("light_min"),
    deepMin: doublePrecision("deep_min"),
    remMin: doublePrecision("rem_min"),
    awakeMin: doublePrecision("awake_min"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sleep_records_provider_external_id_idx").on(t.userId, t.provider, t.externalId),
    index("sleep_records_user_provider_date_idx").on(t.userId, t.provider, t.date),
  ],
);

export const workouts = pgTable(
  "workouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: healthProviderEnum("provider").notNull().default("whoop"),
    // Whoop's workout UUID, or the HKWorkout UUID from Apple Health.
    externalId: text("external_id").notNull(),
    date: date("date").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    durationMin: doublePrecision("duration_min"),
    sport: text("sport"),
    strain: doublePrecision("strain"),
    avgHr: doublePrecision("avg_hr"),
    maxHr: doublePrecision("max_hr"),
    kilojoules: doublePrecision("kilojoules"),
    distanceM: doublePrecision("distance_m"),
    // True once the athlete has hand-entered distanceM (e.g. a treadmill/no-GPS workout the
    // provider synced with no distance). A resync only overwrites distanceM when the provider
    // sends a real value — see upsertWorkout — so a manual entry survives future syncs until
    // the provider itself reports a distance, at which point this flips back to false.
    distanceManual: boolean("distance_manual").notNull().default(false),
    // Scoring extras. strain is Whoop-only (see cycles.strain); the rest are reported by both
    // providers for GPS sports, with percentRecorded and zoneDurations Whoop-only —
    // HealthKit exposes neither a recording-coverage figure nor Whoop's zone taxonomy.
    percentRecorded: doublePrecision("percent_recorded"),
    altitudeGainM: doublePrecision("altitude_gain_m"),
    altitudeChangeM: doublePrecision("altitude_change_m"),
    zoneDurations: jsonb("zone_durations").$type<{
      zone_zero_milli: number;
      zone_one_milli: number;
      zone_two_milli: number;
      zone_three_milli: number;
      zone_four_milli: number;
      zone_five_milli: number;
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workouts_provider_external_id_idx").on(t.userId, t.provider, t.externalId),
    index("workouts_user_provider_date_idx").on(t.userId, t.provider, t.date),
  ],
);

// --- Training plan / calendar ---

export const trainingPlans = pgTable(
  "training_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source").notNull().default("trainingpeaks_csv"),
    status: planStatusEnum("status").notNull().default("inactive"),
    brief: text("brief"),
    rawFile: text("raw_file"), // stored path, kept for re-parsing
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // At most one active training plan per user.
    uniqueIndex("training_plans_one_active_per_user_idx")
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    index("training_plans_user_status_idx").on(t.userId, t.status),
  ],
);

export const plannedRuns = pgTable(
  "planned_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => trainingPlans.id, { onDelete: "set null" }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMin: doublePrecision("duration_min"),
    distanceM: doublePrecision("distance_m"),
    runType: runTypeEnum("run_type").notNull().default("easy"),
    targetPaceSPerKm: doublePrecision("target_pace_s_per_km"),
    plannedTss: doublePrecision("planned_tss"),
    description: text("description"),
    structure: jsonb("structure"), // { intervals: [...] }
    status: runStatusEnum("status").notNull().default("planned"),
    gcalEventId: text("gcal_event_id"),
    gcalEtag: text("gcal_etag"),
    origin: runOriginEnum("origin").notNull().default("manual"),
    // The Whoop workout this planned run was actually executed as. `status` has carried a
    // 'completed' value since the first migration and nothing ever wrote it: the plan and the
    // workouts synced from Whoop were two parallel tables that never touched, so the app could
    // say what was intended and what happened but never that they were the same session.
    // Null means "not linked" — which, read together with `reconciled_at` and `status`, is how
    // "not looked at yet" stays distinguishable from "looked at, and nothing matched".
    actualWorkoutId: uuid("actual_workout_id").references(() => workouts.id, {
      onDelete: "set null",
    }),
    // Who decided this link. See runMatchSourceEnum: 'auto' rows are the sweep's own guess and
    // it rewrites them freely; 'manual' rows are the athlete's correction and the sweep leaves
    // them alone. Null on runs no pass has touched. A correction is itself a labelled example
    // of a match the heuristic got wrong, which is why it's attributed rather than just applied.
    matchSource: runMatchSourceEnum("match_source"),
    // When a reconciliation pass last decided about this run. Distinct from `updated_at`, which
    // any edit moves. Without it a run sitting at 'planned' is ambiguous: not yet reconciled, or
    // reconciled and genuinely unmatched.
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("planned_runs_user_scheduled_idx").on(t.userId, t.scheduledAt),
    uniqueIndex("planned_runs_gcal_event_id_idx").on(t.userId, t.gcalEventId),
    // One workout satisfies at most one planned run. Without this, a double-session day where
    // the matcher mis-assigns leaves the same 10k counted twice and adherence reads over 100%.
    // Partial so the many unlinked runs don't collide on NULL.
    uniqueIndex("planned_runs_actual_workout_idx")
      .on(t.userId, t.actualWorkoutId)
      .where(sql`${t.actualWorkoutId} IS NOT NULL`),
  ],
);

// --- Recommendations ---

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    ruleId: text("rule_id").notNull(),
    severity: recommendationSeverityEnum("severity").notNull(),
    summary: text("summary").notNull(),
    reason: text("reason").notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    proposedChanges: jsonb("proposed_changes").notNull().default([]),
    status: recommendationStatusEnum("status").notNull().default("pending"),
    // Which engine produced this card — see recommendations/sources/. Every row is already a
    // features -> action -> outcome triple (input_snapshot, proposed_changes, status/applied_at);
    // without this column that training set has no attribution, and it can't be reconstructed
    // after the fact. Defaults to 'rules' because the rules engine is the only producer to date,
    // which makes the backfill of historical rows correct by construction.
    source: text("source").notNull().default("rules"),
    // Version of the producing model, for scoring one model revision against another. Null for
    // deterministic sources — the rules engine is versioned by the repo, not by a column.
    modelVersion: text("model_version"),
    // Priority order decided by the rules engine (0 = the primary card). Persisted rather than
    // re-derived at read time so the ranking evaluate() computes — severity, then actionable
    // before advisory, then declared rule order — is what the dashboard actually renders.
    rank: integer("rank").notNull().default(0),
    // Content hash of {ruleId, summary, reason, proposedChanges} — deliberately excludes
    // `date` so a dismissal survives the day rolling over. Lets generateRecommendations tell
    // "this is the same conflict the athlete already dismissed" apart from "this is a new
    // one", instead of resurrecting an identical card on every regeneration.
    fingerprint: text("fingerprint").notNull().default(""),
    // The world outside the athlete's body at decision time: a projection of each planned run
    // this card proposes changing, plus the calendar windows that conflicted with it. Without
    // it `proposed_changes` names a run id and nothing more, so a training set can't tell a
    // 20-mile long run from a 3-mile shakeout, and busy periods (fetched live from Google,
    // persisted nowhere else) are gone the moment the request ends. Deliberately excludes
    // calendar event titles — see buildTrainingContext in recommendations/trainingContext.ts.
    // Nullable: rows written before this column existed have none.
    decisionContext: jsonb("decision_context"),
    // What became of the advice, as opposed to what became of the card. `status` records the
    // click; this records the consequence — for each run the card proposed changing, whether it
    // was actually executed and how the session that happened compared to the one that was
    // planned, plus the recovery score the following morning. Written once by the reconciliation
    // sweep, after the targeted runs are reconciled and never revised, so a training set can ask
    // "did following this advice help?" rather than only "did they click accept?".
    // Nullable: unwritten until the runs settle, and permanently null for cards resolved before
    // this column existed.
    outcomeContext: jsonb("outcome_context"),
    // When this card was first returned by the GET route — i.e. actually rendered to the
    // athlete. Null means it was never seen, which is what makes an expired row interpretable:
    // "never shown" is not a training example, "shown and not acted on" is a real negative.
    firstShownAt: timestamp("first_shown_at", { withTimezone: true }),
    // When this row left `pending` — set on all four terminal transitions (accepted, dismissed,
    // expired, stale), not just the ones the athlete drove. Against created_at it gives
    // time-to-decision for free. The column name predates that broader meaning; renaming it
    // isn't worth a migration.
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recommendations_user_date_idx").on(t.userId, t.date),
    index("recommendations_user_fingerprint_idx").on(t.userId, t.fingerprint, t.status),
    // Backs the GET route's "only sources rendered for this athlete" filter.
    index("recommendations_user_source_status_idx").on(t.userId, t.source, t.status),
    // At most one *pending* row per (user, rule) — makes the regenerate-on-ingestion path
    // (webhooks, dashboard reads, nightly safety net) idempotent under real concurrency
    // instead of relying on a non-atomic delete-then-insert. Resolved rows (accepted/dismissed)
    // are excluded so history can keep multiple rows per rule.
    //
    // `date` is deliberately NOT part of this index: with it, every new day minted a second
    // pending row for the same rule while the retraction sweep only ever looked at today's
    // date, so live cards piled up across days and proposed edits to runs already in the past.
    // The column stays for display and audit.
    //
    // `source` is part of the key so two sources emitting the same `ruleId` (a model trained to
    // reproduce a rule's label, say) get a row each instead of clobbering one another on upsert.
    uniqueIndex("recommendations_pending_unique_idx")
      .on(t.userId, t.source, t.ruleId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

// --- Global AI assistant chat ---

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_sessions_user_updated_idx").on(t.userId, t.updatedAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_session_created_idx").on(t.sessionId, t.createdAt)],
);

// --- Sync bookkeeping ---

export const syncState = pgTable(
  "sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Widened beyond oauthProviderEnum to carry "apple_health", which is a data provider with
    // no OAuth connection behind it — the iOS app pushes to us. It shares this table because
    // lastPolledAt means the same thing for it: the watermark through which the app's view of
    // that provider is complete, which is what the reconciliation sweep's coverage gate needs.
    provider: syncProviderEnum("provider").notNull(),
    // Google
    syncToken: text("sync_token"),
    channelId: text("channel_id"),
    channelExpiration: timestamp("channel_expiration", { withTimezone: true }),
    // Whoop / Apple Health
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sync_state_user_provider_idx").on(t.userId, t.provider)],
);

export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plannedRunId: uuid("planned_run_id")
      .notNull()
      .references(() => plannedRuns.id, { onDelete: "cascade" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    appVersion: jsonb("app_version").notNull(),
    gcalVersion: jsonb("gcal_version").notNull(),
    resolution: text("resolution").notNull().default("app_won"),
    acknowledged: boolean("acknowledged").notNull().default(false),
  },
  (t) => [index("sync_conflicts_planned_run_idx").on(t.plannedRunId)],
);

// --- Backoffice (invite allowlist + denied-signup log) ---

// DB-backed replacement for the ALLOWED_EMAILS env var — lets an admin invite new signups
// from the backoffice without an env change + redeploy. isEmailAllowedToSignUp (routes/auth.ts)
// checks this table first and falls back to env.allowedEmails for back-compat.
export const invitedEmails = pgTable("invited_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  note: text("note"),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
});

// Legacy, from when the invite allowlist gated account creation: one row per email that had
// attempted a sign-up without being on it. Signup is open now, so nothing writes new rows —
// the only remaining reads clear a deleted account's row (routes/admin.ts, routes/account.ts)
// so historical rows can't outlive the person. Safe to drop in a later cleanup.
export const accessRequests = pgTable("access_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  firstRequestedAt: timestamp("first_requested_at", { withTimezone: true }).notNull().defaultNow(),
  lastRequestedAt: timestamp("last_requested_at", { withTimezone: true }).notNull().defaultNow(),
  requestCount: integer("request_count").notNull().default(1),
  status: accessRequestStatusEnum("status").notNull().default("pending"),
});

// Single-use tokens backing both email verification and password reset (lib/authTokens.ts).
// Only a sha256 hash of the token is stored — the raw token exists only in the emailed link,
// same principle as never storing a plaintext password.
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: authTokenPurposeEnum("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose)],
);

// One row per completed conversation turn (i.e. once per user-facing AI route call, after the
// tool-use loop finishes) — not one row per Anthropic API call, since a single turn can involve
// several tool-use round trips. estimatedCostMicros is computed at write time from lib/aiCost.ts
// so a later price-table change doesn't retroactively rewrite historical spend.
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    surface: aiSurfaceEnum("surface").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull(),
    // Integer micro-dollars (1,000,000 = $1) — avoids float rounding on money.
    estimatedCostMicros: integer("estimated_cost_micros").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_user_created_idx").on(t.userId, t.createdAt)],
);

// Idempotency ledger for the Stripe webhook (integrations/stripe/webhooks.ts). Stripe retries
// delivery and can also send events out of order, so every handler inserts the event id here
// before acting; a unique-violation on insert means "already processed" and the handler no-ops.
/**
 * Devices authorized to push Apple Health data for an athlete.
 *
 * Everything else in the app authenticates with the signed session cookie, and inside the
 * Capacitor WebView that keeps working unchanged. This table exists for the half of the iOS
 * app that runs *outside* the WebView: HealthKit background delivery wakes the native app when
 * new data lands, often with no WebView alive and the athlete's phone in their pocket. That
 * wake is the entire point of the iOS app — it is what makes this morning's recovery already
 * be there — and native Swift has no access to the WebView's cookie jar.
 *
 * So a device holds its own long-lived bearer token in the iOS Keychain. Only the SHA-256 hash
 * is stored here, the same treatment auth_tokens gives emailed links: a database copy is not
 * enough to push data as the athlete. Unlike those, this token is reusable and has no expiry —
 * it is a device registration, not a one-shot link — which is why it needs to be revocable
 * per-device from Settings, and why lastSeenAt is recorded, so an athlete can tell which
 * registration is the phone in their hand and which is the one they sold.
 */
export const healthIngestDevices = pgTable(
  "health_ingest_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Device-reported label ("iPhone 15 Pro"), shown in Settings so a revoke targets the right
    // one. Cosmetic and untrusted: it comes from the device and is never matched on.
    label: text("label"),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Last successful push. Null until the device's first one — which distinguishes "registered
    // but HealthKit permission was never granted" from "syncing fine".
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("health_ingest_devices_token_hash_idx").on(t.tokenHash),
    index("health_ingest_devices_user_idx").on(t.userId),
  ],
);

export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: text("id").primaryKey(), // the provider's event id, e.g. Stripe's evt_...
  provider: text("provider").notNull(), // "stripe" today; free-text so a future provider needs no migration
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- App settings ---

/**
 * Single-row table of operator-controlled runtime settings — the state behind the backoffice
 * switches that shouldn't require a redeploy to flip. Deliberately a table rather than env vars:
 * these are toggled live from the backoffice, and an env var can't be.
 *
 * Always exactly one row, id "singleton", created by the migration. Readers treat a missing row
 * as "all defaults" so a freshly created database still behaves.
 */
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey().default("singleton"),
  // Default for whether model-sourced recommendations are rendered to athletes. Per-account
  // overrides live on users.modelRenderedOverride; resolve the pair through
  // lib/modelRendering.ts rather than reading either column directly.
  //
  // This gates *rendering* only. The model source runs and is scored in shadow on every
  // ingestion event regardless, which is what keeps a continuous accept/dismiss record to
  // evaluate a candidate model against before it is ever switched on.
  modelRenderedDefault: boolean("model_rendered_default").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Who last flipped a switch here — same admin-attribution pattern as users.compedBy.
  updatedBy: uuid("updated_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
});
