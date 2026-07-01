/**
 * ETL stub: import bathymetric depth scalars from SMHI Vattenwebb.
 *
 * Run:  pnpm etl:depth
 *
 * ## Status
 * STUB — the Vattenwebb bathymetry export URL/format is not yet wired.  The
 * script logs a clear error and exits 1 if `DEPTH_URL` is not configured.
 * Once the export URL is known, implement the mapper and remove the TODO guards.
 *
 * See scripts/etl/README.md (depth section) for dataset notes and the
 * placeholder URL pattern.
 *
 * ## Idempotency
 * When wired, the script upserts on `lake_id` PK (ON CONFLICT DO UPDATE) so
 * re-runs are safe.
 *
 * ## Architecture
 * Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
 * time.  The runtime path — `src/lib/water/depth.ts#depthFor` — reads from the
 * `lake_depth` table; if no row exists `depthFor()` returns null (graceful
 * absence).
 */

// ---------------------------------------------------------------------------
// URL placeholder — operator must supply the real download URL.
// See scripts/etl/README.md (depth section) for the Vattenwebb export path.
// ---------------------------------------------------------------------------
const DEPTH_URL =
  process.env.DEPTH_URL ??
  "<TODO: SMHI Vattenwebb bathymetry export URL — see scripts/etl/README.md>";

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions — adapt once the real bathymetry export schema is known.
// ---------------------------------------------------------------------------

/**
 * Expected shape of one record from the bathymetry export.
 * Field names are placeholders — verify against the actual dataset.
 */
export interface DepthRecord {
  /** Lake identifier (must match `lakes.id`). */
  lakeId: string;
  /** Maximum lake depth in metres (may be absent in source). */
  maxDepthM?: number | null;
  /** Mean lake depth in metres (may be absent in source). */
  meanDepthM?: number | null;
}

/** Row shape matching the `lake_depth` Drizzle table. */
export interface DepthRow {
  lakeId: string;
  maxDepthM: number | null;
  meanDepthM: number | null;
}

// ---------------------------------------------------------------------------
// Pure mapper — unit-tested in src/lib/water/depth.test.ts
// ---------------------------------------------------------------------------

/**
 * Map a single bathymetry record to a `lake_depth` table row.
 * Throws if required fields are missing or depth values are non-finite.
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

// ---------------------------------------------------------------------------
// Script body — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (DEPTH_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: DEPTH_URL is not configured.\n" +
        "Set the DEPTH_URL environment variable to the SMHI Vattenwebb\n" +
        "bathymetry export URL.\n" +
        "See scripts/etl/README.md (depth section) for details.",
    );
    process.exit(1);
  }

  // Lazy imports — kept out of module scope so tests never touch DB or env.
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { sql } = await import("drizzle-orm");
  const { lakeDepth } = await import("@/shared/db/schema");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const pg = postgres(databaseUrl);
  const db = drizzle(pg);

  console.log(`Fetching bathymetry dataset from: ${DEPTH_URL}`);
  const res = await fetch(DEPTH_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch dataset: ${res.status} ${res.statusText}`);
  }

  // TODO: parse the actual bathymetry export format once it is known.
  // The Vattenwebb export may be JSON, CSV, or another format.
  const records: DepthRecord[] = (await res.json()) as DepthRecord[];
  console.log(`Fetched ${records.length} records.`);

  const rows: DepthRow[] = [];
  let errors = 0;

  for (const record of records) {
    try {
      rows.push(mapDepthRecord(record));
    } catch (err) {
      errors++;
      console.warn(`Skipping record: ${(err as Error).message}`);
    }
  }

  // H8: chunk so a large INSERT can't exceed Postgres' 65,535 bind-param cap.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(lakeDepth)
      .values(chunk)
      .onConflictDoUpdate({
        target: lakeDepth.lakeId,
        set: {
          maxDepthM: sql`excluded.max_depth_m`,
          meanDepthM: sql`excluded.mean_depth_m`,
        },
      });
  }

  console.log(`\nDone. Imported: ${rows.length}, Skipped (errors): ${errors}`);

  await pg.end();
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("import-depth.ts") ||
    process.argv[1].endsWith("import-depth.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
