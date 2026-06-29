CREATE TABLE "forecast_cache" (
	"lake_id" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"doc" jsonb NOT NULL
);
