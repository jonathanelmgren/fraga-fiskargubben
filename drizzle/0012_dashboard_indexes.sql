-- Manual migration: dashboard + hot-path lookup indexes (finding L-idx1).
-- Applied by the Drizzle migrator via the _journal.json entry (idx 12).
-- Follows the hand-written pattern of 0011_hotpath_indexes.sql, because the
-- partial index below cannot be expressed in the Drizzle schema (drizzle-kit
-- generate only emits plain column indexes).

-- L-idx1: ADR-0005's motivating dashboards query analytics_event by lake
-- ("which lakes do people ask about"). 0011 only indexed (type, created_at),
-- so a lake-scoped query still scans. A PARTIAL index on the rows that carry a
-- lake_id keeps it small (most events have a lake_id; gate/funnel events do
-- not) and serves the `WHERE lake_id = $1` predicate.
CREATE INDEX IF NOT EXISTS analytics_event_lake_id_idx
  ON "analytics_event" (lake_id)
  WHERE lake_id IS NOT NULL;

-- L-idx1: per-conversation funnels (ADR-0005) filter analytics_event by
-- conversation_id. Partial on the rows that carry one.
CREATE INDEX IF NOT EXISTS analytics_event_conversation_id_idx
  ON "analytics_event" (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- L-idx1: nearestStation() filters metobs_station by `parameter = $1` ('temp'
-- or 'pressure') on every cache miss. The composite PK is (id, parameter), so
-- a predicate on parameter alone is not served by the PK — a dedicated index
-- avoids a seq scan over the station table.
CREATE INDEX IF NOT EXISTS metobs_station_parameter_idx
  ON "metobs_station" (parameter);
