import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/shared/db/client";
import { lakes } from "@/shared/db/schema";
import { formatLabel as _formatLabel } from "./resolve-helpers";

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

export { formatLabel } from "./resolve-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// searchLakes — ranked typeahead (ADR-0002)
// Ranking: exact name match → prefix match → trigram similarity, tiebreak areaHa DESC.
// Unnamed bodies (name IS NULL) are excluded.
// ─────────────────────────────────────────────────────────────────────────────

export async function searchLakes(q: string): Promise<LakeHit[]> {
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
        lower(name) = lower(${q})
        OR lower(name) LIKE lower(${q}) || '%'
        OR similarity(name, ${q}) > 0.1
      )
    ORDER BY
      CASE
        WHEN lower(name) = lower(${q})       THEN 0
        WHEN lower(name) LIKE lower(${q}) || '%' THEN 1
        ELSE 2
      END ASC,
      similarity(name, ${q}) DESC,
      area_ha DESC
    LIMIT 10
  `);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    label: _formatLabel({
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
      lower(name) = lower(${name})
      ${municipality ? sql`AND lower(municipality) = lower(${municipality})` : sql``}
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
