CREATE TYPE "public"."oauth_provider" AS ENUM('whoop', 'google');--> statement-breakpoint
CREATE TYPE "public"."recommendation_severity" AS ENUM('info', 'yellow', 'red');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."run_origin" AS ENUM('imported', 'manual', 'recommendation');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('planned', 'completed', 'skipped', 'moved');--> statement-breakpoint
CREATE TYPE "public"."run_type" AS ENUM('easy', 'tempo', 'interval', 'long', 'recovery', 'race', 'rest');--> statement-breakpoint
CREATE TYPE "public"."score_state" AS ENUM('SCORED', 'PENDING_SCORE', 'UNSCORABLE');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planned_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_min" double precision,
	"distance_m" double precision,
	"run_type" "run_type" DEFAULT 'easy' NOT NULL,
	"target_pace_s_per_km" double precision,
	"planned_tss" double precision,
	"description" text,
	"structure" jsonb,
	"status" "run_status" DEFAULT 'planned' NOT NULL,
	"gcal_event_id" text,
	"gcal_etag" text,
	"origin" "run_origin" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"rule_id" text NOT NULL,
	"severity" "recommendation_severity" NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"proposed_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "recommendation_status" DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recovery_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"whoop_sleep_id" text NOT NULL,
	"cycle_id" text,
	"date" date NOT NULL,
	"recovery_score" double precision,
	"hrv_rmssd_ms" double precision,
	"resting_hr" double precision,
	"spo2" double precision,
	"skin_temp_c" double precision,
	"score_state" "score_state" DEFAULT 'PENDING_SCORE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sleep_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"whoop_sleep_id" text NOT NULL,
	"date" date NOT NULL,
	"duration_min" double precision,
	"efficiency_pct" double precision,
	"sleep_debt_min" double precision,
	"respiratory_rate" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"planned_run_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"app_version" jsonb NOT NULL,
	"gcal_version" jsonb NOT NULL,
	"resolution" text DEFAULT 'app_won' NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"sync_token" text,
	"channel_id" text,
	"channel_expiration" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT 'trainingpeaks_csv' NOT NULL,
	"raw_file" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whoop_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"whoop_workout_id" text NOT NULL,
	"date" date NOT NULL,
	"sport" text,
	"strain" double precision,
	"avg_hr" double precision,
	"max_hr" double precision,
	"kilojoules" double precision,
	"distance_m" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planned_runs" ADD CONSTRAINT "planned_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planned_runs" ADD CONSTRAINT "planned_runs_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recovery_metrics" ADD CONSTRAINT "recovery_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sleep_records" ADD CONSTRAINT "sleep_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_planned_run_id_planned_runs_id_fk" FOREIGN KEY ("planned_run_id") REFERENCES "public"."planned_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whoop_workouts" ADD CONSTRAINT "whoop_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_connections_user_provider_idx" ON "oauth_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planned_runs_user_scheduled_idx" ON "planned_runs" USING btree ("user_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "planned_runs_gcal_event_id_idx" ON "planned_runs" USING btree ("gcal_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_user_date_idx" ON "recommendations" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recovery_metrics_whoop_sleep_id_idx" ON "recovery_metrics" USING btree ("whoop_sleep_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_metrics_user_date_idx" ON "recovery_metrics" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sleep_records_whoop_sleep_id_idx" ON "sleep_records" USING btree ("whoop_sleep_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sleep_records_user_date_idx" ON "sleep_records" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_conflicts_planned_run_idx" ON "sync_conflicts" USING btree ("planned_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_state_user_provider_idx" ON "sync_state" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whoop_workouts_whoop_workout_id_idx" ON "whoop_workouts" USING btree ("whoop_workout_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whoop_workouts_user_date_idx" ON "whoop_workouts" USING btree ("user_id","date");