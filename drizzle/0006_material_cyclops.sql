CREATE TABLE "water_temp" (
	"lake_id" text PRIMARY KEY NOT NULL,
	"temp_c" double precision NOT NULL,
	"as_of" timestamp with time zone
);
