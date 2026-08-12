CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"whoop_cycle_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone,
	"timezone_offset" text,
	"score_state" "score_state" DEFAULT 'PENDING_SCORE' NOT NULL,
	"strain" double precision,
	"kilojoule" double precision,
	"avg_hr" integer,
	"max_hr" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_whoop_cycle_id_idx" ON "cycles" USING btree ("whoop_cycle_id");--> statement-breakpoint
CREATE INDEX "cycles_user_start_idx" ON "cycles" USING btree ("user_id","start");--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "cycle_id" text;--> statement-breakpoint
ALTER TABLE "sleep_records" ADD COLUMN "nap" boolean DEFAULT false NOT NULL;
