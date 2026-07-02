-- Manual migration: enable PostGIS + backfill lakes.eu_cd for existing VISS rows.
-- Applied by Drizzle migrator via _journal.json entry (idx 15).
-- Must run AFTER 0014_lakes_eucd_source.sql (which adds eu_cd + source).
--
-- PostGIS is needed by the Lantmäteriet full-lake-coverage ETL (ogr2ogr loads
-- the Topografi GeoPackage into a PostGIS staging table; centroid + reproject in
-- SQL). See docs/plans/2026-07-02-lantmateriet-full-lake-coverage.md.
--
-- Requires a PostGIS-enabled Postgres image (e.g. postgis/postgis:18-3.6). On a
-- plain postgres image `CREATE EXTENSION postgis` fails — swap the image first.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
-- Backfill: every existing lake came from VISS, where the id IS the EU_CD. Set
-- eu_cd = id so the MVM/NORS joins (which will move to lakes.eu_cd) keep working
-- through the transition. source already defaults to 'viss'.
UPDATE "lakes" SET "eu_cd" = "id" WHERE "eu_cd" IS NULL;
