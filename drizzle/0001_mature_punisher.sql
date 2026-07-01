CREATE TABLE "analytics_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"lake_id" text,
	"conversation_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
