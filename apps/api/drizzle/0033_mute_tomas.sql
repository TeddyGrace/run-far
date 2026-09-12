CREATE TABLE IF NOT EXISTS "health_ingest_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "health_ingest_devices" ADD CONSTRAINT "health_ingest_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "health_ingest_devices_token_hash_idx" ON "health_ingest_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_ingest_devices_user_idx" ON "health_ingest_devices" USING btree ("user_id");