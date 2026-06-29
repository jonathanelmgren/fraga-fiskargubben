CREATE TABLE "metobs_station" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"parameter" text NOT NULL,
	CONSTRAINT "metobs_station_id_parameter_pk" PRIMARY KEY("id","parameter")
);
