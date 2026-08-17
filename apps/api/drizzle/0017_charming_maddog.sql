ALTER TABLE "users" ADD COLUMN "tutorial_completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "tutorial_completed_at" = now() WHERE "tutorial_completed_at" IS NULL;