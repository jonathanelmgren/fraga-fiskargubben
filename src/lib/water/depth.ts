/**
 * Bathymetric depth lookup per lake.
 *
 * ## Data availability
 * Max and mean depth scalars are available for ~10k Swedish lakes from the
 * SMHI Vattenwebb bathymetry dataset.  Most lakes have NO row — `depthFor()`
 * returns `null` for those (graceful absence).
 *
 * ## ETL
 * Rows are populated by `scripts/etl/import-depth.ts` from the SMHI
 * Vattenwebb bathymetry export.  The ETL is currently a stub; see
 * scripts/etl/README.md (depth section) for the placeholder note.
 *
 * ## Architecture
 * Per ADR-0002: ETL runs once (or on-demand), never at request time.  The
 * runtime path here reads from the `lake_depth` table; if no row exists the
 * caller receives `null` and must decide how to proceed.
 */

// ────────────────────────────────────────────────────────────────────────────
// Input/output types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Raw depth record from the bathymetry source (field names are placeholders —
 * update `DepthRecord` and `mapDepthRecord` once the real dataset schema is known).
 */
export interface DepthRecord {
  /** Lake identifier matching `lakes.id`. */
  lakeId: string;
  /** Maximum lake depth in metres (optional in source). */
  maxDepthM?: number | null;
  /** Mean lake depth in metres (optional in source). */
  meanDepthM?: number | null;
}

/** Row shape matching the `lake_depth` Drizzle table. */
export interface DepthRow {
  lakeId: string;
  maxDepthM: number | null;
  meanDepthM: number | null;
}

/** Shape returned by `depthFor` — scalars or null for absent lakes. */
export type DepthResult = {
  maxDepthM: number | null;
  meanDepthM: number | null;
} | null;

// ────────────────────────────────────────────────────────────────────────────
// Pure mapper — unit-tested in depth.test.ts
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map a single bathymetry record to a `lake_depth` table row.
 *
 * - `lakeId` is required — throws if absent or empty.
 * - `maxDepthM` / `meanDepthM` are optional; missing/undefined/null → stored
 *   as `null`.  If present, must be finite numbers (throws otherwise).
 */
export function mapDepthRecord(record: DepthRecord): DepthRow {
  if (!record.lakeId) {
    throw new Error("Depth record is missing required lakeId.");
  }

  const { maxDepthM, meanDepthM } = record;

  if (maxDepthM !== undefined && maxDepthM !== null) {
    if (!Number.isFinite(maxDepthM)) {
      throw new Error(
        `Invalid maxDepthM on depth record for lakeId: ${record.lakeId} — must be a finite number.`,
      );
    }
  }

  if (meanDepthM !== undefined && meanDepthM !== null) {
    if (!Number.isFinite(meanDepthM)) {
      throw new Error(
        `Invalid meanDepthM on depth record for lakeId: ${record.lakeId} — must be a finite number.`,
      );
    }
  }

  return {
    lakeId: record.lakeId,
    maxDepthM: maxDepthM ?? null,
    meanDepthM: meanDepthM ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DB-backed lookup
// ────────────────────────────────────────────────────────────────────────────

/**
 * Look up bathymetric depth scalars for a lake.
 *
 * Returns `{ maxDepthM, meanDepthM }` if the `lake_depth` table has a row for
 * this lake, or `null` if no row exists (most lakes have none).
 *
 * Requires `DATABASE_URL` at runtime; never called during pure unit tests.
 */
export async function depthFor(lakeId: string): Promise<DepthResult> {
  // H12: shared lazy single-row-by-lakeId lookup (keeps DB out of test scope).
  const { lakeDepth } = await import("@/shared/db/schema");
  const { selectOneByLakeId } = await import("./select-one");

  const row = (await selectOneByLakeId(
    lakeDepth,
    lakeDepth.lakeId,
    {
      maxDepthM: lakeDepth.maxDepthM,
      meanDepthM: lakeDepth.meanDepthM,
    },
    lakeId,
  )) as { maxDepthM: number | null; meanDepthM: number | null } | null;
  if (row === null) return null;

  return { maxDepthM: row.maxDepthM, meanDepthM: row.meanDepthM };
}
