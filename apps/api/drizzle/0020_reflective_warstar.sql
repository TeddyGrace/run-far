DROP INDEX IF EXISTS "cycles_whoop_cycle_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "planned_runs_gcal_event_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "recovery_metrics_whoop_sleep_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "sleep_records_whoop_sleep_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "whoop_workouts_whoop_workout_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cycles_whoop_cycle_id_idx" ON "cycles" USING btree ("user_id","whoop_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "planned_runs_gcal_event_id_idx" ON "planned_runs" USING btree ("user_id","gcal_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recovery_metrics_whoop_sleep_id_idx" ON "recovery_metrics" USING btree ("user_id","whoop_sleep_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sleep_records_whoop_sleep_id_idx" ON "sleep_records" USING btree ("user_id","whoop_sleep_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whoop_workouts_whoop_workout_id_idx" ON "whoop_workouts" USING btree ("user_id","whoop_workout_id");