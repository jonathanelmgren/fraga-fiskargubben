CREATE TABLE "lakes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"municipality" text NOT NULL,
	"county" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"area_ha" double precision NOT NULL
);
