/**
 * Fish species per surveyed lake.
 *
 * ## Data source
 * Rows are populated by `scripts/etl/import-aqua.ts` from the SLU Aqua /
 * Sötebasen test-fishing (provfiske) data.  The ETL joins survey stations to
 * lakes at import time using `stationMatchesLake` (ADR-0002); this runtime
 * file does NOT call the SLU Aqua API and does NOT reference any API key.
 *
 * ## Runtime lookup
 * `speciesFor(lakeId)` is a pure table lookup — no live SLU call.  Returns the
 * species array or `null` when the lake has no survey data (graceful absence —
 * most lakes will have none until the ETL is run).
 */

import "server-only";

// ────────────────────────────────────────────────────────────────────────────
// Pure mapper — unit-testable without DB or network
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw species list:
 *  - Trim surrounding whitespace.
 *  - Convert to lower case.
 *  - Filter out blank / whitespace-only entries.
 *  - Deduplicate (preserving first-occurrence order).
 */
export function normalizeSpecies(rawList: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawList) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// DB-backed lookup — server-only, NO SLU Aqua API reference
// ────────────────────────────────────────────────────────────────────────────

/**
 * Look up the fish species surveyed in a lake.
 *
 * Returns the stored species array or `null` when the lake has no Aqua/
 * Sötebasen data (graceful absence — most lakes will have none until the ETL
 * is run).
 *
 * This function MUST NOT call the SLU Aqua API or import anything from
 * `src/shared/env.ts`.  The ETL (import-aqua.ts) is the only place that
 * touches external services.
 */
export async function speciesFor(lakeId: string): Promise<string[] | null> {
  // H12: shared lazy single-row-by-lakeId lookup (keeps DB out of test scope).
  // L11: `confidence` is intentionally NOT selected — it was queried-then-
  // discarded before, and surfacing it on the Signals contract widens the
  // Signals type broadly.  [~] deferred: species provenance on Signals.
  const { lakeSpecies } = await import("@/shared/db/schema");
  const { selectOneByLakeId } = await import("./select-one");

  const row = (await selectOneByLakeId(
    lakeSpecies,
    lakeSpecies.lakeId,
    { species: lakeSpecies.species },
    lakeId,
  )) as { species: string[] | null } | null;
  if (row === null) return null;

  return row.species ?? [];
}
