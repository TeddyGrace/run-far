DROP INDEX IF EXISTS "recommendations_pending_unique_idx";--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The pending index used to include `date`, so every new day minted a second live card for
-- the same rule while the retraction sweep only ever looked at today's date. Collapse that
-- backlog to the newest pending row per (user, rule) before the narrower index can be built.
DELETE FROM "recommendations" a
  USING "recommendations" b
  WHERE a."status" = 'pending'
    AND b."status" = 'pending'
    AND a."user_id" = b."user_id"
    AND a."rule_id" = b."rule_id"
    AND (a."created_at", a."id") < (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recommendations_pending_unique_idx" ON "recommendations" USING btree ("user_id","rule_id") WHERE "recommendations"."status" = 'pending';
