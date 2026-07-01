import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/shared/db/client";
import { lakes } from "@/shared/db/schema";
import { formatLabel } from "./resolve-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LakeHit = {
  id: string;
  name: string;
  label: string;
  lat: number;
  lon: number;
};

export type Lake = {
  id: string;
  name: string | null;
  municipality: string;
  county: string;
  lat: number;
  lon: number;
  areaHa: number;
};

// L-r1: re-export formatLabel (imported above) for call sites that reach for
// it via the resolve module; no aliased second import.
export { formatLabel } from "./resolve-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// searchLakes — ranked typeahead (ADR-0002)
// Ranking: exact name match → prefix match → trigram similarity, tiebreak areaHa DESC.
// Unnamed bodies (name IS NULL) are excluded.
// ─────────────────────────────────────────────────────────────────────────────

export async function searchLakes(q: string): Promise<LakeHit[]> {
  // L2: cap query length and escape LIKE metacharacters (% and _) in the
  // prefix operand so user input can't inject wildcards or blow up the scan.
  const capped = q.trim().slice(0, 64);
  const likePrefix = `${capped.replace(/([%_\\])/g, "\\$1")}%`;

  // H10: use the trigram similarity OPERATOR `name % $q` (GIN-indexable via
  // lakes_name_trgm_idx) instead of `similarity(name, $q) > 0.1` (which a GIN
  // index cannot serve and forced a per-row similarity() over 100k rows on
  // every keystroke).  The exact/prefix branches use `lower(name)` which is now
  // backed by the lakes_lower_name_idx expression index (migration 0011).
  const rows = await db.execute<{
    id: string;
    name: string;
    municipality: string;
    county: string;
    lat: number;
    lon: number;
  }>(sql`
    SELECT
      id,
      name,
      municipality,
      county,
      lat,
      lon
    FROM ${lakes}
    WHERE
      name IS NOT NULL
      AND (
        lower(name) = lower(${capped})
        OR lower(name) LIKE lower(${likePrefix}) ESCAPE '\\'
        OR name % ${capped}
      )
    ORDER BY
      CASE
        WHEN lower(name) = lower(${capped})       THEN 0
        WHEN lower(name) LIKE lower(${likePrefix}) ESCAPE '\\' THEN 1
        ELSE 2
      END ASC,
      similarity(name, ${capped}) DESC,
      area_ha DESC
    LIMIT 10
  `);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    label: formatLabel({
      name: row.name,
      municipality: row.municipality,
      county: row.county,
    }),
    lat: row.lat,
    lon: row.lon,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveLake — pin a single lake from Extractor output.
// Uses exact + prefix matching only (no loose trigram — resolution must be confident).
// If municipality is given, filters case-insensitively.
// Returns null when ambiguous (>1 match) or no match.
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveLake(
  name: string,
  municipality?: string,
): Promise<Lake | null> {
  const rows = await db.execute<{
    id: string;
    name: string | null;
    municipality: string;
    county: string;
    lat: number;
    lon: number;
    area_ha: number;
  }>(sql`
    SELECT
      id,
      name,
      municipality,
      county,
      lat,
      lon,
      area_ha
    FROM ${lakes}
    WHERE
      name IS NOT NULL
      AND lower(name) = lower(${name})
      ${municipality ? sql`AND lower(municipality) = lower(${municipality})` : sql``}
    -- M4: we only need to distinguish "exactly one" from "more than one", so
    -- LIMIT 2 bounds the read on the /api/ask hot path. A common shared lake
    -- name would otherwise load every match into memory just to count them.
    LIMIT 2
  `);

  if (rows.length !== 1) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    municipality: row.municipality,
    county: row.county,
    lat: row.lat,
    lon: row.lon,
    areaHa: row.area_ha,
  };
}
