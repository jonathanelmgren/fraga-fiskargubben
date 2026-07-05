ALTER TABLE "conversation" ADD COLUMN "status" text DEFAULT 'resolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "resolve_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "user_lat" double precision;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "user_lon" double precision;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "signup_ip_hash" text;