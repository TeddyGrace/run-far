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
    // Gates the daily recovery/recommendations digest email to at most one per calendar day.
    lastRecoveryEmailDate: date("last_recovery_email_date"),
    // Null means "use the server default" (env.ANTHROPIC_MODEL) for that agent.
    assistantModel: text("assistant_model"),
    planModel: text("plan_model"),
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
  (t) => [uniqueIndex("oauth_connections_user_provider_idx").on(t.userId, t.provider)],
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
    uniqueIndex("recovery_metrics_whoop_sleep_id_idx").on(t.whoopSleepId),
    index("recovery_metrics_user_date_idx").on(t.userId, t.date),
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
    uniqueIndex("sleep_records_whoop_sleep_id_idx").on(t.whoopSleepId),
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
    uniqueIndex("whoop_workouts_whoop_workout_id_idx").on(t.whoopWorkoutId),
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
    uniqueIndex("planned_runs_gcal_event_id_idx").on(t.gcalEventId),
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
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recommendations_user_date_idx").on(t.userId, t.date)],
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
