-- Manual migration: enable pg_trgm extension and add GIN trigram index on lakes.name
-- Applied by Drizzle migrator via _journal.json entry (idx 3).
-- This must run AFTER 0002_vengeful_ultimatum.sql which creates the lakes table.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS lakes_name_trgm_idx ON lakes USING gin (name gin_trgm_ops);
