CREATE TYPE "public"."ai_surface" AS ENUM('plan_builder', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."entitlement_source" AS ENUM('comp', 'stripe', 'apple');--> statement-breakpoint
CREATE TYPE "public"."entitlement_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'none');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"surface" "ai_surface" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer NOT NULL,
	"estimated_cost_micros" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entitlement_source" "entitlement_source";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entitlement_status" "entitlement_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entitlement_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "comped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "comped_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "comp_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_comped_by_users_id_fk" FOREIGN KEY ("comped_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripe_customer_id_idx" ON "users" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripe_subscription_id_idx" ON "users" USING btree ("stripe_subscription_id");
-- Backfill: every account already approved before entitlements existed keeps working
-- exactly as before — treated as comped, not as "none" — so this migration doesn't lock
-- out anyone who could already sign in and use the app.
UPDATE "users" SET "entitlement_source" = 'comp', "entitlement_status" = 'active', "comped_at" = "approved_at" WHERE "approved_at" IS NOT NULL AND "entitlement_source" IS NULL;
