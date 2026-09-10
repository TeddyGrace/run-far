CREATE TYPE "public"."run_match_source" AS ENUM('auto', 'manual');--> statement-breakpoint
ALTER TABLE "planned_runs" ADD COLUMN "actual_workout_id" uuid;--> statement-breakpoint
ALTER TABLE "planned_runs" ADD COLUMN "match_source" "run_match_source";--> statement-breakpoint
ALTER TABLE "planned_runs" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "outcome_context" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planned_runs" ADD CONSTRAINT "planned_runs_actual_workout_id_whoop_workouts_id_fk" FOREIGN KEY ("actual_workout_id") REFERENCES "public"."whoop_workouts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "planned_runs_actual_workout_idx" ON "planned_runs" USING btree ("user_id","actual_workout_id") WHERE "planned_runs"."actual_workout_id" IS NOT NULL;