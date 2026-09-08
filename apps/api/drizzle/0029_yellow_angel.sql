ALTER TYPE "public"."recommendation_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "public"."recommendation_status" ADD VALUE 'stale';--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "decision_context" jsonb;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "first_shown_at" timestamp with time zone;