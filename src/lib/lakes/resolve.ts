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
//
// Returns a discriminated result instead of a bare Lake|null so the caller can
// tell WHY resolution failed and prompt precisely (the user asked for "less
// guessing, more prompting"):
//   { kind: "resolved",  lake }               — exactly one match.
//   { kind: "none" }                           — no lake by that name.
//   { kind: "ambiguous", candidates }          — several real lakes share the
//                                                 name; ask which municipality.
// We NEVER pick one silently on ambiguity — a wrong lake gives wrong advice.
// ─────────────────────────────────────────────────────────────────────────────

/** A distinct lake sharing an ambiguous name — enough to ask "which one?". */
export type LakeCandidate = {
  id: string;
  name: string;
  municipality: string;
  county: string;
};

export type ResolveResult =
  | { kind: "resolved"; lake: Lake }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: LakeCandidate[] };

/** How many candidate municipalities to surface on an ambiguous match. */
const AMBIGUOUS_CANDIDATE_LIMIT = 6;

export async function resolveLake(
  name: string,
  municipality?: string,
): Promise<ResolveResult> {
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
    -- Order the biggest lake first so the ambiguity prompt lists the most
    -- likely-meant water bodies. LIMIT is CANDIDATE_LIMIT+1: enough to build
    -- the "which one?" list, +1 only to bound the read (we cap the list below).
    ORDER BY area_ha DESC
    LIMIT ${AMBIGUOUS_CANDIDATE_LIMIT + 1}
  `);

  if (rows.length === 0) {
    return { kind: "none" };
  }

  if (rows.length > 1) {
    return {
      kind: "ambiguous",
      candidates: rows.slice(0, AMBIGUOUS_CANDIDATE_LIMIT).map((row) => ({
        id: row.id,
        name: row.name ?? name,
        municipality: row.municipality,
        county: row.county,
      })),
    };
  }

  const row = rows[0];
  return {
    kind: "resolved",
    lake: {
      id: row.id,
      name: row.name,
      municipality: row.municipality,
      county: row.county,
      lat: row.lat,
      lon: row.lon,
      areaHa: row.area_ha,
    },
  };
}
