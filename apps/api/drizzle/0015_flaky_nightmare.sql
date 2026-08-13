ALTER TABLE "weather_forecasts" ADD COLUMN "icon_code" text;--> statement-breakpoint
ALTER TABLE "weather_forecasts" ADD COLUMN "hourly" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "weather_forecasts" ADD COLUMN "segments" jsonb DEFAULT '[]'::jsonb NOT NULL;