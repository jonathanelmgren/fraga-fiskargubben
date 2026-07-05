/**
 * candidateLakes — the SQL half of the two-stage lake resolution (rebuild spec
 * docs/superpowers/specs/2026-07-03-chat-first-rebuild-design.md).
 *
 * Stage 1 (this module): a broad, ranked candidate search. Unlike the old
 * resolveLake (exact/prefix only), this deliberately includes fuzzy trigram
 * hits and does NOT hard-filter on municipality — the user's colloquial
 * municipality ("Åsunden i Ulricehamn") can differ from Lantmäteriet's tag
 * (Borås). Ranking and the final pick happen in stage 2 (the Haiku resolver),
 * which sees each candidate's municipality/county/area/distance.
 *
 * Nearby mode: with no lake name but a user location, returns the nearest
 * named lakes so "vad ska jag fiska här i närheten?" can resolve too.
 */
import "server-only";
import { sql } from "drizzle-orm";
import { haversine } from "@/lib/geo/haversine";
import { db } from "@/shared/db/client";
import { lakes } from "@/shared/db/schema";
import type { Lake } from "./resolve";

export type UserLocation = { lat: number; lon: number };

export type CandidateLake = Lake & {
  /** Great-circle distance from the user's location, when known. */
  distanceKm?: number;
};

/** How many candidates the Haiku resolver gets to choose from. */
export const CANDIDATE_LIMIT = 10;

/** Nearby mode: bounding half-box in degrees latitude (~50 km). */
const NEARBY_BOX_DEG = 0.45;

/** Nearby mode: skip puddles — a fishable lake is at least this big. */
const NEARBY_MIN_AREA_HA = 1;

type CandidateRow = {
  id: string;
  name: string | null;
  municipality: string;
  county: string;
  lat: number;
  lon: number;
  area_ha: number;
};

/**
 * Attach haversine distance from the user's location to each candidate.
 * Pure — exported for unit tests.
 */
export function attachDistances(
  rows: Lake[],
  userLoc?: UserLocation,
): CandidateLake[] {
  if (!userLoc) return rows;
  return rows.map((row) => ({
    ...row,
    distanceKm:
      Math.round(haversine(userLoc, { lat: row.lat, lon: row.lon }) * 10) / 10,
  }));
}

function toLake(row: CandidateRow): Lake {
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

export async function candidateLakes(
  name: string,
  userLoc?: UserLocation,
): Promise<CandidateLake[]> {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    if (!userLoc) return [];
    return nearbyLakes(userLoc);
  }

  // L2 (as in searchLakes): cap query length and escape LIKE metacharacters.
  const capped = trimmed.slice(0, 64);
  const likePrefix = `${capped.replace(/([%_\\])/g, "\\$1")}%`;

  const rows = await db.execute<CandidateRow>(sql`
    SELECT id, name, municipality, county, lat, lon, area_ha
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
        WHEN lower(name) = lower(${capped}) THEN 0
        WHEN lower(name) LIKE lower(${likePrefix}) ESCAPE '\\' THEN 1
        ELSE 2
      END ASC,
      similarity(name, ${capped}) DESC,
      area_ha DESC
    LIMIT ${CANDIDATE_LIMIT}
  `);

  return attachDistances(rows.map(toLake), userLoc);
}

/**
 * Nearest named lakes to the user — bounding-box prefilter (index-friendly)
 * ordered by planar distance (cos-corrected lon), exact haversine attached
 * after. Good to well under 1% error at this scale.
 */
async function nearbyLakes(userLoc: UserLocation): Promise<CandidateLake[]> {
  const lonBox = NEARBY_BOX_DEG / Math.cos((userLoc.lat * Math.PI) / 180);

  const rows = await db.execute<CandidateRow>(sql`
    SELECT id, name, municipality, county, lat, lon, area_ha
    FROM ${lakes}
    WHERE
      name IS NOT NULL
      AND area_ha >= ${NEARBY_MIN_AREA_HA}
      AND lat BETWEEN ${userLoc.lat - NEARBY_BOX_DEG} AND ${userLoc.lat + NEARBY_BOX_DEG}
      AND lon BETWEEN ${userLoc.lon - lonBox} AND ${userLoc.lon + lonBox}
    ORDER BY
      power(lat - ${userLoc.lat}, 2)
        + power((lon - ${userLoc.lon}) * cos(radians(${userLoc.lat})), 2) ASC
    LIMIT ${CANDIDATE_LIMIT}
  `);

  return attachDistances(rows.map(toLake), userLoc);
}
