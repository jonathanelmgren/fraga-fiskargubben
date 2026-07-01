/**
 * Water colour (humic / clear) and Secchi sight depth per lake.
 *
 * ## Data source
 * Rows are populated by `scripts/etl/import-mvm.ts` from the SLU
 * Miljödata-MVM API (SampleSites / FullSamples).  The ETL runs once (or
 * on-demand by an operator) — never at request time (ADR-0002).
 *
 * ## Runtime lookup
 * `colourFor(lakeId)` is a pure table lookup with NO live MVM call and NO
 * reference to MVM_TICKET.  The ticket is import-time only.
 *
 * ## Colour classification threshold
 * Brown/humic vs clear is derived by `deriveColour` (see below).
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Input to deriveColour — either absorbans at 420 nm or Swedish Pt colour number. */
export interface ColourInput {
  /** Absorbance at 420 nm (A₄₂₀, unit: m⁻¹ or abs/m). */
  absorbans420?: number;
  /** Swedish water colour by Pt scale (mg Pt/L, also written "färgtal"). */
  fargtal?: number;
}

/** The two colour categories stored in water_colour. */
export type WaterColour = "brown" | "clear";

export type ColourResult = {
  colour: WaterColour;
  sightDepthM: number | null;
  confidence: "high" | "low";
} | null;

// ────────────────────────────────────────────────────────────────────────────
// Pure classifier
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify a water sample as 'brown' (humic) or 'clear'.
 *
 * ## Threshold rationale
 * - **absorbans420 > 0.1 m⁻¹** → brown.
 *   This boundary corresponds roughly to the EEA/EC classification of
 *   "humic-influenced" waters and aligns with the Swedish EPA colour
 *   guidelines.  Waters with A₄₂₀ ≤ 0.1 are considered oligotrophic/clear.
 *
 * - **färgtal > 30 mg Pt/L** → brown.
 *   30 mg Pt/L is a commonly cited SLU/Naturvårdsverket boundary between
 *   clear and lightly coloured water in Swedish national monitoring.
 *
 * If both are provided, absorbans420 takes precedence.
 * Throws if neither field is provided.
 */
export function deriveColour(input: ColourInput): WaterColour {
  if (input.absorbans420 !== undefined) {
    return input.absorbans420 > 0.1 ? "brown" : "clear";
  }

  if (input.fargtal !== undefined) {
    return input.fargtal > 30 ? "brown" : "clear";
  }

  throw new Error(
    "deriveColour: at least one of absorbans420 or fargtal must be provided.",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// DB-backed lookup — server-only, NO MVM_TICKET reference
// ────────────────────────────────────────────────────────────────────────────

/**
 * Look up water colour and sight depth for a lake.
 *
 * Returns the stored row or `null` when the lake has no MVM data (graceful
 * absence — most lakes will have none until the ETL is run).
 *
 * This function MUST NOT import or call anything from `src/shared/env.ts`
 * (and therefore never touches MVM_TICKET).  The ticket is ETL-only.
 */
export async function colourFor(lakeId: string): Promise<ColourResult> {
  // H12: shared lazy single-row-by-lakeId lookup (keeps DB out of test scope).
  const { waterColour } = await import("@/shared/db/schema");
  const { selectOneByLakeId } = await import("./select-one");

  const row = (await selectOneByLakeId(
    waterColour,
    waterColour.lakeId,
    {
      colour: waterColour.colour,
      sightDepthM: waterColour.sightDepthM,
      confidence: waterColour.confidence,
    },
    lakeId,
  )) as {
    colour: string;
    sightDepthM: number | null;
    confidence: string;
  } | null;
  if (row === null) return null;

  // M8: the DB columns are plain `text`, so a bad value must not silently
  // become an invalid union member.  Validate at the boundary; an unrecognised
  // value is treated as graceful absence (null) rather than a confident-wrong
  // signal.
  const colour: WaterColour | null =
    row.colour === "brown" || row.colour === "clear" ? row.colour : null;
  if (colour === null) return null;

  const confidence: "high" | "low" = row.confidence === "high" ? "high" : "low";

  return {
    colour,
    sightDepthM: row.sightDepthM,
    confidence,
  };
}
