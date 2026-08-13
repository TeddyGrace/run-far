CREATE TABLE IF NOT EXISTS "weather_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"high_temp_f" double precision,
	"low_temp_f" double precision,
	"short_forecast" text,
	"precip_probability_pct" double precision,
	"wind_speed" text,
	"wind_direction" text,
	"icon_url" text,
	"alerts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weather_forecasts" ADD CONSTRAINT "weather_forecasts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "weather_forecasts_user_date_idx" ON "weather_forecasts" USING btree ("user_id","date");