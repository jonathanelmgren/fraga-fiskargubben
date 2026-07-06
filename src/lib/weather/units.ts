/**
 * Pure SMHI unit conversions — no server-only import so signal builders and
 * tests can use them without loading the fetch/cache machinery.
 */

/**
 * SMHI snow1g reports `cloud_area_fraction` in OCTAS (0–8), not percent —
 * live responses cap at 8 (fully overcast). Convert to percent for the
 * `cloudPct` signal so the LLM never reads octas 8 as "8% moln, nästan klart".
 * Clamped to [0, 8]; returns undefined for absent/non-finite input so callers
 * can pass the raw optional param straight through.
 */
export function octasToPercent(octas: number | undefined): number | undefined {
  if (octas === undefined || !Number.isFinite(octas)) return undefined;
  const clamped = Math.min(8, Math.max(0, octas));
  return Math.round((clamped / 8) * 100);
}

/**
 * Sanitize an SMHI probability param to [0, 100]. SMHI uses negative
 * sentinels (e.g. -9 on precipitation_frozen_part) for "not applicable" —
 * a negative probability must become absent, not a confusing -9 in the
 * snapshot. Returns undefined for absent/non-finite/negative input.
 */
export function probabilityPct(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v) || v < 0) return undefined;
  return Math.min(100, v);
}
