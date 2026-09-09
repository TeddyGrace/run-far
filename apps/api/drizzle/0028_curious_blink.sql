CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"model_rendered_default" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
DROP INDEX IF EXISTS "recommendations_pending_unique_idx";--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "source" text DEFAULT 'rules' NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "model_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "model_rendered_override" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_user_source_status_idx" ON "recommendations" USING btree ("user_id","source","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recommendations_pending_unique_idx" ON "recommendations" USING btree ("user_id","source","rule_id") WHERE "recommendations"."status" = 'pending';--> statement-breakpoint
-- Seed the singleton settings row. Readers (lib/modelRendering.ts) treat a missing row as
-- all-defaults and the admin PATCH upserts, so nothing depends on this existing — it's here so
-- the table's state is explicit rather than implied by absence.
INSERT INTO "app_settings" ("id") VALUES ('singleton') ON CONFLICT DO NOTHING;
