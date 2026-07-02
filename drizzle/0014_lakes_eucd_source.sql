ALTER TABLE "lakes" ADD COLUMN "eu_cd" text;--> statement-breakpoint
ALTER TABLE "lakes" ADD COLUMN "source" text DEFAULT 'viss' NOT NULL;