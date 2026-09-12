CREATE TYPE "public"."health_provider" AS ENUM('whoop', 'apple_health');--> statement-breakpoint
CREATE TYPE "public"."hrv_metric" AS ENUM('rmssd', 'sdnn');--> statement-breakpoint
CREATE TYPE "public"."recovery_score_source" AS ENUM('provider', 'derived');--> statement-breakpoint
CREATE TYPE "public"."sync_provider" AS ENUM('whoop', 'google', 'apple_health');--> statement-breakpoint
ALTER TABLE "whoop_workouts" RENAME TO "workouts";--> statement-breakpoint
ALTER TABLE "cycles" RENAME COLUMN "whoop_cycle_id" TO "external_id";--> statement-breakpoint
ALTER TABLE "recovery_metrics" RENAME COLUMN "whoop_sleep_id" TO "external_id";--> statement-breakpoint
ALTER TABLE "sleep_records" RENAME COLUMN "whoop_sleep_id" TO "external_id";--> statement-breakpoint
ALTER TABLE "workouts" RENAME COLUMN "whoop_workout_id" TO "external_id";--> statement-breakpoint
ALTER TABLE "planned_runs" DROP CONSTRAINT "planned_runs_actual_workout_id_whoop_workouts_id_fk";
--> statement-breakpoint
ALTER TABLE "workouts" DROP CONSTRAINT "whoop_workouts_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "cycles_whoop_cycle_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "cycles_user_start_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "recovery_metrics_whoop_sleep_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "recovery_metrics_user_date_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "sleep_records_whoop_sleep_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "sleep_records_user_date_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "whoop_workouts_whoop_workout_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "whoop_workouts_user_date_idx";--> statement-breakpoint
-- Hand-edited: Postgres will not cast between two enum types implicitly, so the generated
-- bare SET DATA TYPE fails with 42804. Round-tripping through text is safe here because
-- sync_provider is a strict superset of oauth_provider — every existing value ("whoop",
-- "google") is a valid sync_provider label, so no row can fail the cast.
ALTER TABLE "sync_state" ALTER COLUMN "provider" SET DATA TYPE sync_provider USING "provider"::text::sync_provider;--> statement-breakpoint
ALTER TABLE "cycles" ADD COLUMN "provider" "health_provider" DEFAULT 'whoop' NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_metrics" ADD COLUMN "provider" "health_provider" DEFAULT 'whoop' NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_metrics" ADD COLUMN "recovery_score_source" "recovery_score_source" DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_metrics" ADD COLUMN "hrv_metric" "hrv_metric" DEFAULT 'rmssd' NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_metrics" ADD COLUMN "score_components" jsonb;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "provider" "health_provider" DEFAULT 'whoop' NOT NULL;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "sleep_need_min" double precision;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "in_bed_min" double precision;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "light_min" double precision;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "deep_min" double precision;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "rem_min" double precision;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "awake_min" double precision;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active_health_provider" "health_provider" DEFAULT 'whoop' NOT NULL;--> statement-breakpoint
ALTER TABLE "workouts" ADD COLUMN "provider" "health_provider" DEFAULT 'whoop' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planned_runs" ADD CONSTRAINT "planned_runs_actual_workout_id_workouts_id_fk" FOREIGN KEY ("actual_workout_id") REFERENCES "public"."workouts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workouts" ADD CONSTRAINT "workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cycles_provider_external_id_idx" ON "cycles" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cycles_user_provider_start_idx" ON "cycles" USING btree ("user_id","provider","start");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recovery_metrics_provider_external_id_idx" ON "recovery_metrics" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_metrics_user_provider_date_idx" ON "recovery_metrics" USING btree ("user_id","provider","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sleep_records_provider_external_id_idx" ON "sleep_records" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sleep_records_user_provider_date_idx" ON "sleep_records" USING btree ("user_id","provider","date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workouts_provider_external_id_idx" ON "workouts" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workouts_user_provider_date_idx" ON "workouts" USING btree ("user_id","provider","date");