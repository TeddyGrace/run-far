ALTER TABLE "whoop_workouts" ADD COLUMN "percent_recorded" double precision;--> statement-breakpoint
ALTER TABLE "whoop_workouts" ADD COLUMN "altitude_gain_m" double precision;--> statement-breakpoint
ALTER TABLE "whoop_workouts" ADD COLUMN "altitude_change_m" double precision;--> statement-breakpoint
ALTER TABLE "whoop_workouts" ADD COLUMN "zone_durations" jsonb;
