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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Enums ---

export const oauthProviderEnum = pgEnum("oauth_provider", ["whoop", "google"]);
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
export const planStatusEnum = pgEnum("plan_status", ["active", "inactive", "archived"]);
export const recommendationSeverityEnum = pgEnum("recommendation_severity", [
  "info",
  "yellow",
  "red",
]);
export const recommendationStatusEnum = pgEnum("recommendation_status", [
  "pending",
  "accepted",
  "dismissed",
]);
export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);
export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const accessRequestStatusEnum = pgEnum("access_request_status", [
  "pending",
  "invited",
  "dismissed",
]);

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
    // Gates the daily recovery/recommendations digest email to at most one per calendar day.
    lastRecoveryEmailDate: date("last_recovery_email_date"),
    // Null means "use the server default" (env.ANTHROPIC_MODEL) for that agent.
    assistantModel: text("assistant_model"),
    planModel: text("plan_model"),
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
    // Null means the new-account tutorial overlay hasn't been completed/skipped yet. Existing
    // accounts are backfilled to non-null at migration time so only new signups see it.
    tutorialCompletedAt: timestamp("tutorial_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_google_sub_idx").on(t.googleSub)],
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

// NWS daily forecast, one row per (user, calendar date). Upserted on every
// generateRecommendations run, so it's always as fresh as the last dashboard read /
// webhook / nightly sync — see recommendations/service.ts.
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

// --- Whoop data ---

export const recoveryMetrics = pgTable(
  "recovery_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    whoopSleepId: text("whoop_sleep_id").notNull(),
    cycleId: text("cycle_id"),
    date: date("date").notNull(),
    recoveryScore: doublePrecision("recovery_score"),
    hrvRmssdMs: doublePrecision("hrv_rmssd_ms"),
    restingHr: doublePrecision("resting_hr"),
    spo2: doublePrecision("spo2"),
    skinTempC: doublePrecision("skin_temp_c"),
    scoreState: scoreStateEnum("score_state").notNull().default("PENDING_SCORE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recovery_metrics_whoop_sleep_id_idx").on(t.userId, t.whoopSleepId),
    index("recovery_metrics_user_date_idx").on(t.userId, t.date),
  ],
);

// Whoop's Physiological Cycle — the actual unit Whoop organizes a member's data around
// (wake-to-wake, can cross midnight, can run longer than 24h), not a calendar day. `end` is
// null while the cycle is still open/ongoing. No cycle.* webhooks exist, so this table is
// kept fresh by polling (full sync) and by piggybacking on the sleep/recovery webhook handlers.
export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    whoopCycleId: text("whoop_cycle_id").notNull(),
    start: timestamp("start", { withTimezone: true }).notNull(),
    end: timestamp("end", { withTimezone: true }),
    timezoneOffset: text("timezone_offset"),
    scoreState: scoreStateEnum("score_state").notNull().default("PENDING_SCORE"),
    strain: doublePrecision("strain"),
    kilojoule: doublePrecision("kilojoule"),
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cycles_whoop_cycle_id_idx").on(t.userId, t.whoopCycleId),
    index("cycles_user_start_idx").on(t.userId, t.start),
  ],
);

export const sleepRecords = pgTable(
  "sleep_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    whoopSleepId: text("whoop_sleep_id").notNull(),
    cycleId: text("cycle_id"),
    // True for a nap; false for the primary sleep that starts the cycle. Needed to pick the
    // right row when a cycle has both — see buildRecoverySnapshot's sleepDebtMinToday lookup.
    nap: boolean("nap").notNull().default(false),
    date: date("date").notNull(),
    durationMin: doublePrecision("duration_min"),
    efficiencyPct: doublePrecision("efficiency_pct"),
    // Whoop "Sleep performance" — % of sleep needed that was achieved (the Sleep score).
    performancePct: doublePrecision("performance_pct"),
    sleepDebtMin: doublePrecision("sleep_debt_min"),
    respiratoryRate: doublePrecision("respiratory_rate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sleep_records_whoop_sleep_id_idx").on(t.userId, t.whoopSleepId),
    index("sleep_records_user_date_idx").on(t.userId, t.date),
  ],
);

export const whoopWorkouts = pgTable(
  "whoop_workouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    whoopWorkoutId: text("whoop_workout_id").notNull(),
    date: date("date").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    durationMin: doublePrecision("duration_min"),
    sport: text("sport"),
    strain: doublePrecision("strain"),
    avgHr: doublePrecision("avg_hr"),
    maxHr: doublePrecision("max_hr"),
    kilojoules: doublePrecision("kilojoules"),
    distanceM: doublePrecision("distance_m"),
    // Full Whoop WorkoutScore extras — present for GPS sports and HR-zone breakdowns.
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
    uniqueIndex("whoop_workouts_whoop_workout_id_idx").on(t.userId, t.whoopWorkoutId),
    index("whoop_workouts_user_date_idx").on(t.userId, t.date),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("planned_runs_user_scheduled_idx").on(t.userId, t.scheduledAt),
    uniqueIndex("planned_runs_gcal_event_id_idx").on(t.userId, t.gcalEventId),
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
    // Content hash of {ruleId, summary, reason, proposedChanges} — deliberately excludes
    // `date` so a dismissal survives the day rolling over. Lets generateRecommendations tell
    // "this is the same conflict the athlete already dismissed" apart from "this is a new
    // one", instead of resurrecting an identical card on every regeneration.
    fingerprint: text("fingerprint").notNull().default(""),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recommendations_user_date_idx").on(t.userId, t.date),
    index("recommendations_user_fingerprint_idx").on(t.userId, t.fingerprint, t.status),
    // At most one *pending* row per (user, day, rule) — makes the regenerate-on-ingestion
    // path (webhooks, dashboard reads, nightly safety net) idempotent under real concurrency
    // instead of relying on a non-atomic delete-then-insert. Resolved rows (accepted/dismissed)
    // are excluded so history can keep multiple rows per rule per day.
    uniqueIndex("recommendations_pending_unique_idx")
      .on(t.userId, t.date, t.ruleId)
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
    provider: oauthProviderEnum("provider").notNull(),
    // Google
    syncToken: text("sync_token"),
    channelId: text("channel_id"),
    channelExpiration: timestamp("channel_expiration", { withTimezone: true }),
    // Whoop
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

// One row per email that has attempted (and been denied) Google sign-up — upserted by
// findOrCreateGoogleUser (routes/auth.ts) so the backoffice can surface real access requests
// instead of relying on the client-side mailto link in AccessRequested.tsx.
export const accessRequests = pgTable("access_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  firstRequestedAt: timestamp("first_requested_at", { withTimezone: true }).notNull().defaultNow(),
  lastRequestedAt: timestamp("last_requested_at", { withTimezone: true }).notNull().defaultNow(),
  requestCount: integer("request_count").notNull().default(1),
  status: accessRequestStatusEnum("status").notNull().default("pending"),
});
