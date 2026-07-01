-- Manual migration: hot-path lookup indexes (findings H9 + H10).
-- Applied by the Drizzle migrator via the _journal.json entry (idx 11).
-- Follows the hand-written pattern of 0003_pg_trgm.sql, because the partial
-- and expression indexes below cannot be expressed in the Drizzle schema
-- (drizzle-kit generate only emits plain column indexes).

-- H9: message.conversation_id is queried 2-3× per request (history,
-- turn-count) — a btree index avoids a per-request seq scan that grows with
-- the table.
CREATE INDEX IF NOT EXISTS message_conversation_id_idx
  ON "message" (conversation_id);

-- H9: every registration claim looks up an UNCLAIMED conversation by token
-- (claim_token = $1 AND user_id IS NULL).  A PARTIAL index on the unclaimed
-- subset keeps it small and serves the exact predicate.
CREATE INDEX IF NOT EXISTS conversation_claim_token_idx
  ON "conversation" (claim_token)
  WHERE user_id IS NULL;

-- H9: analytics_event is append-only and grows unbounded; queries filter by
-- (type, created_at).  Composite btree supports type-scoped time-range scans.
CREATE INDEX IF NOT EXISTS analytics_event_type_created_at_idx
  ON "analytics_event" (type, created_at);

-- H10: searchLakes' exact/prefix branches use lower(name); an EXPRESSION
-- index on lower(name) lets those indexable predicates drive the query (the
-- GIN trigram index from 0003 serves the `name % $q` similarity branch).
CREATE INDEX IF NOT EXISTS lakes_lower_name_idx
  ON "lakes" (lower(name));
