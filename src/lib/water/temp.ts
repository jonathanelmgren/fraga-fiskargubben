/**
 * Water-temperature estimation (estimate-first) + S-HYPE override.
 *
 * ## Estimate formula
 *
 * Primary water-temp model — used for ALL lakes by default because most Swedish
 * lakes have no modeled data.  The estimate is a rough proxy, not science.
 *
 * Formula:
 *   1. Season baseline (°C): winter=2, spring=9, summer=19, autumn=11
 *   2. Air-temp trend nudge: +1.5 (warming) / -1.5 (cooling) / 0 (steady)
 *      — scaled by lake-responsiveness factor (see step 3).
 *   3. Lake-size responsiveness: small lakes heat and cool faster.
 *      responsiveness = 1.0 for lakes < 50 ha, decaying on a log10 scale and
 *      clamped to a 0.6 floor.  Computed as: clamp(1 - log10(areaHa/50) * 0.2,
 *      0.6, 1.0).  L12: the floor of 0.6 is reached near ~15,800 ha (where
 *      log10(area/50) * 0.2 = 0.4), NOT at 2000 ha as a stale comment claimed.
 *      Defaults to 0.8 when areaHa is unknown (a medium-sized lake assumption).
 *
 * Result is clamped to [0, 30] — the realistic Swedish freshwater range.
 *
 * ## S-HYPE override
 *
 * WHERE the operator has seeded the `water_temp` table from the Vattenwebb
 * S-HYPE export, `waterTempFor()` replaces the estimate with the modeled value
 * (source "modeled", confidence "high").  The pure decision function
 * `chooseWaterTemp()` is also exported for unit testing without a DB.
 */

import type { WithProvenance } from "@/lib/signals/types";

// ────────────────────────────────────────────────────────────────────────────
// Input type
// ────────────────────────────────────────────────────────────────────────────

export type Season = "winter" | "spring" | "summer" | "autumn";
export type AirTempTrend = "warming" | "cooling" | "steady";

export interface WaterTempInput {
  /** Calendar season at the query date. */
  season: Season;
  /** 5-day air-temp trend (from signals/metobs). Optional — defaults to "steady". */
  airTempTrend5d?: AirTempTrend;
  /** Lake surface area in hectares. Optional — defaults to medium-lake assumption. */
  areaHa?: number;
}

/** A seeded S-HYPE row from the `water_temp` table (only the fields we use). */
export interface WaterTempRow {
  tempC: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Season baselines
// ────────────────────────────────────────────────────────────────────────────

const SEASON_BASELINE_C: Record<Season, number> = {
  winter: 2,
  spring: 9,
  summer: 19,
  autumn: 11,
};

/** Maximum nudge from air-temp trend in either direction (°C). */
const TREND_NUDGE_C = 1.5;

/** Trend direction multiplier. */
const TREND_MULTIPLIER: Record<AirTempTrend, number> = {
  warming: 1,
  steady: 0,
  cooling: -1,
};

/** Default responsiveness when areaHa is unknown (medium-lake assumption). */
const DEFAULT_RESPONSIVENESS = 0.8;

// ────────────────────────────────────────────────────────────────────────────
// Pure formula
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute lake responsiveness from surface area.
 *
 * Small lakes (< 50 ha) are fully responsive (1.0).
 * Responsiveness decays on a log10 scale and is clamped to a 0.6 floor, which
 * is reached near ~15,800 ha (L12 — not 2000 ha).
 */
function lakeResponsiveness(areaHa: number): number {
  if (areaHa < 50) return 1.0;
  const factor = 1.0 - Math.log10(areaHa / 50) * 0.2;
  return Math.max(0.6, Math.min(1.0, factor));
}

/**
 * Estimate water temperature from season, air-temp trend, and lake size.
 * Pure — no I/O. Returns `source: "estimated"`, `confidence: "low"`.
 */
export function estimateWaterTemp(
  input: WaterTempInput,
): WithProvenance<number> {
  const { season, airTempTrend5d = "steady", areaHa } = input;

  const baseline = SEASON_BASELINE_C[season];
  const responsiveness =
    areaHa !== undefined ? lakeResponsiveness(areaHa) : DEFAULT_RESPONSIVENESS;
  const nudge =
    TREND_MULTIPLIER[airTempTrend5d] * TREND_NUDGE_C * responsiveness;

  const raw = baseline + nudge;
  const value = Math.max(0, Math.min(30, raw));

  return {
    value,
    provenance: { source: "estimated", confidence: "low" },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Override decision — pure, unit-testable
// ────────────────────────────────────────────────────────────────────────────

/**
 * Choose between a seeded S-HYPE row and the estimate fallback.
 *
 * - If `modeledRow` is non-null: return the modeled value with high confidence.
 * - Otherwise: return the estimate as-is.
 *
 * This function is pure — it never touches the DB.  It is exported so the
 * override logic can be unit-tested without a database connection.
 */
export function chooseWaterTemp(
  modeledRow: WaterTempRow | null,
  estimate: WithProvenance<number>,
): WithProvenance<number> {
  if (modeledRow !== null) {
    return {
      value: modeledRow.tempC,
      provenance: { source: "modeled", confidence: "high" },
    };
  }
  return estimate;
}

// ────────────────────────────────────────────────────────────────────────────
// DB-backed lookup
// ────────────────────────────────────────────────────────────────────────────

/**
 * Look up water temperature for a lake.
 *
 * 1. Computes the estimate from `estimateInput` (always — used as fallback).
 * 2. Queries the `water_temp` table for a seeded S-HYPE row by `lakeId`.
 * 3. Delegates to `chooseWaterTemp` — returns modeled if present, else estimate.
 *
 * Requires `DATABASE_URL` at runtime; never called during tests (use
 * `chooseWaterTemp` for unit tests instead).
 */
export async function waterTempFor(
  lakeId: string,
  estimateInput: WaterTempInput,
): Promise<WithProvenance<number>> {
  const estimate = estimateWaterTemp(estimateInput);

  // H12: shared lazy single-row-by-lakeId lookup (keeps DB out of test scope).
  const { waterTemp } = await import("@/shared/db/schema");
  const { selectOneByLakeId } = await import("./select-one");

  const row = (await selectOneByLakeId(
    waterTemp,
    waterTemp.lakeId,
    { tempC: waterTemp.tempC },
    lakeId,
  )) as WaterTempRow | null;
  return chooseWaterTemp(row, estimate);
}
