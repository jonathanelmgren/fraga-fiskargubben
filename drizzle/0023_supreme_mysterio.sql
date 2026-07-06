ALTER TABLE "user" ADD COLUMN "feedback_prompted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "feedback_prompted_chat_count" integer DEFAULT 0 NOT NULL;