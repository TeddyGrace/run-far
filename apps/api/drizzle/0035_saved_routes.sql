CREATE TYPE "public"."route_source" AS ENUM('manual', 'ai');--> statement-breakpoint
ALTER TYPE "public"."ai_surface" ADD VALUE 'route_planner';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"source" "route_source" DEFAULT 'manual' NOT NULL,
	"distance_m" double precision NOT NULL,
	"elevation_gain_m" double precision,
	"elevation_loss_m" double precision,
	"waypoints" jsonb NOT NULL,
	"geometry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saved_routes" ADD CONSTRAINT "saved_routes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_routes_user_created_idx" ON "saved_routes" USING btree ("user_id","created_at");