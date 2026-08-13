-- Dedupe existing duplicate pending recommendations before the unique index below would
-- reject them: keep the most recently created row per (user_id, date, rule_id) among pending
-- rows, drop the rest. Safe to re-run — a no-op once there are no duplicates left.
DELETE FROM "recommendations" r
USING (
	SELECT "id",
		ROW_NUMBER() OVER (
			PARTITION BY "user_id", "date", "rule_id"
			ORDER BY "created_at" DESC, "id" DESC
		) AS rn
	FROM "recommendations"
	WHERE "status" = 'pending'
) dup
WHERE r."id" = dup."id" AND dup.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recommendations_pending_unique_idx" ON "recommendations" USING btree ("user_id","date","rule_id") WHERE "recommendations"."status" = 'pending';
