/**
 * Import-time join predicate: decides whether an MVM sample station belongs to
 * a given lake (ADR-0002).
 *
 * ## Approximation
 * We do not store lake polygon geometry — only the centroid (lat/lon) and
 * areaHa.  A full polygon containment check is therefore impossible.  Instead:
 *
 *   1. Distance ≤ 200 m from centroid → HIGH confidence.
 *      Rationale: SLU station equipment is anchored in the lake; a station
 *      within 200 m of the centroid almost certainly belongs to it.
 *
 *   2. Distance ≤ areaRadius from centroid → LOW confidence.
 *      areaRadius = sqrt(areaHa × 10 000 / π) metres  (circle of equal area).
 *      Rationale: the station is geometrically plausible but not certain — the
 *      actual shoreline may exclude this point, and very elongated lakes will
 *      have large radii that extend outside the true boundary.
 *
 *   3. Distance > areaRadius → NO match.
 *
 * When polygon geometry is added (e.g. from SWDB/GSD), replace step 1/2 with
 * a point-in-polygon test and demote the centroid fallback to a tie-breaker.
 */

import { haversine } from "@/lib/geo/haversine";

export interface StationPoint {
  lat: number;
  lon: number;
}

export interface LakeAnchor {
  lat: number;
  lon: number;
  areaHa: number;
}

/**
 * M8: a discriminated union so `confidence` only exists when `matches` is true.
 * Previously `confidence` was always present and set to a meaningless "low" on
 * a non-match (structural convenience) — callers could read a confidence that
 * had no meaning.  Now the type forces a `matches` check before reading it.
 */
export type MatchResult =
  | { matches: true; confidence: "high" | "low" }
  | { matches: false };

/** Threshold below which a station is considered certainly inside the lake (km). */
const HIGH_CONFIDENCE_RADIUS_KM = 0.2; // 200 m

/**
 * Determine whether a sample station belongs to a lake.
 *
 * Returns `{ matches: true, confidence: 'high' }` when the station is within
 * 200 m of the centroid; `{ matches: true, confidence: 'low' }` when within
 * the equal-area circle; `{ matches: false }` otherwise.
 */
export function stationMatchesLake(
  station: StationPoint,
  lake: LakeAnchor,
): MatchResult {
  const distKm = haversine(station, lake);
  const areaRadiusKm = Math.sqrt((lake.areaHa * 10_000) / Math.PI) / 1000;

  if (distKm <= HIGH_CONFIDENCE_RADIUS_KM) {
    return { matches: true, confidence: "high" };
  }

  if (distKm <= areaRadiusKm) {
    return { matches: true, confidence: "low" };
  }

  return { matches: false };
}
