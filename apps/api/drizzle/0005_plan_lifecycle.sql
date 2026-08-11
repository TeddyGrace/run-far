CREATE TYPE "public"."plan_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
ALTER TYPE "public"."run_origin" ADD VALUE IF NOT EXISTS 'ai_generated';--> statement-breakpoint
ALTER TABLE "training_plans" ADD COLUMN "status" "plan_status" DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "training_plans" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "training_plans" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: most recent plan per user becomes active; others stay inactive.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY imported_at DESC) AS rn
  FROM training_plans
)
UPDATE training_plans
SET status = 'active'
WHERE id IN (SELECT id FROM ranked WHERE rn = 1);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "training_plans_one_active_per_user_idx"
  ON "training_plans" USING btree ("user_id")
  WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_plans_user_status_idx"
  ON "training_plans" USING btree ("user_id", "status");
