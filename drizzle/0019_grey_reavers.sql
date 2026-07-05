ALTER TABLE "user" ADD COLUMN "share_location" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "tos_accepted_at" timestamp;