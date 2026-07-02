/**
 * ETL: import per-lake max depth from SLU Aqua's NORS aggregated report.
 *
 * Run:  pnpm etl:depth
 *
 * ## Source — VERIFIED live 2026-07-01
 * The NORS aggregated report (same endpoint as the Aqua species ETL) carries a
 * `maxDjup` (max depth, metres) field keyed by `eU_CD` (the lake PK):
 *   GET https://dvfisk.slu.se/api/v1/nors/data-aggregerad/rapport
 * Field description: https://dvfisk.slu.se/assets/NORS_databeskrivning.pdf
 * (section "Nätprovfiske aggregerade data" → "Maxdjup: Sjöns maxdjup i meter").
 *
 * This reuses the NORS report rather than a separate bathymetry export.
 *
 * ## FLAG — mean depth is NOT available from NORS
 * NORS aggregated data provides `maxDjup` only, so `meanDepthM` is always null
 * here.  SMHI Vattenwebb DOES publish mean/max depth (medeldjup/maxdjup) per
 * water body, but only via the interactive "Modelldata per område" viewer /
 * per-area Excel export — there is no documented open bulk REST/WFS endpoint
 * (SMHI: lake geometries are Lantmäteriet-derived and not open data).  If mean
 * depth is required, an operator must export it manually and point DEPTH_URL at
 * a file:// JSON array of DepthRecord objects (set DEPTH_SOURCE=custom).
 *
 * ## Idempotency
 * Upserts on `lake_id` PK (ON CONFLICT DO UPDATE) so re-runs are safe.
 *
 * ## Architecture
 * Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
 * time.  The runtime path — `src/lib/water/depth.ts#depthFor` — reads from the
 * `lake_depth` table; if no row exists `depthFor()` returns null (graceful
 * absence).
 */

// ---------------------------------------------------------------------------
// Source — VERIFIED live 2026-07-01.  Defaults to the NORS aggregated report.
// Override DEPTH_URL with a file:// path to a manual Vattenwebb bathymetry
// export (a JSON array of DepthRecord) AND set DEPTH_SOURCE=custom to supply
// mean depth.  See scripts/etl/README.md (depth section).
// ---------------------------------------------------------------------------
const DEPTH_URL =
  process.env.DEPTH_URL ??
  "https://dvfisk.slu.se/api/v1/nors/data-aggregerad/rapport";

/**
 * True when DEPTH_URL is the NORS aggregated report (default): records are
 * mapped via mapNorsDepthRecord (maxDjup/eU_CD).  False when the operator
 * supplies a pre-shaped DepthRecord export (DEPTH_SOURCE=custom): records are
 * mapped via mapDepthRecord directly.
 */
const DEPTH_SOURCE_IS_NORS =
  process.env.DEPTH_SOURCE?.toLowerCase() !== "custom" &&
  DEPTH_URL.includes("data-aggregerad");

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * Shape of one record from a custom bathymetry export (DEPTH_SOURCE=custom).
 * The NORS default path uses NorsDepthRecord instead.
 */
export interface DepthRecord {
  /** Lake identifier (must match `lakes.id`). */
  lakeId: string;
  /** Maximum lake depth in metres (may be absent in source). */
  maxDepthM?: number | null;
  /** Mean lake depth in metres (may be absent in source). */
  meanDepthM?: number | null;
}

/**
 * Relevant fields of one NORS aggregated record (see import-aqua.ts for the
 * full shape).  VERIFIED live 2026-07-01.
 */
export interface NorsDepthRecord {
  /** EU WFD water-body code (matches `lakes.id`); " " (blank) for some rows. */
  eU_CD?: string | null;
  /** Max depth in metres. */
  maxDjup?: number | null;
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

/**
 * Map one NORS aggregated record to a `lake_depth` row.  Returns null (rather
 * than throwing) for rows without an eU_CD or without a finite maxDjup — NORS
 * carries ~4250 lakes but only those with both are usable depth rows.  Mean
 * depth is unavailable from NORS (see the module FLAG) and is always null.
 */
export function mapNorsDepthRecord(record: NorsDepthRecord): DepthRow | null {
  const lakeId = (record.eU_CD ?? "").trim();
  if (!lakeId) return null;

  const { maxDjup } = record;
  if (maxDjup === undefined || maxDjup === null || !Number.isFinite(maxDjup)) {
    return null;
  }

  return { lakeId, maxDepthM: maxDjup, meanDepthM: null };
}

// ---------------------------------------------------------------------------
// Script body — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (DEPTH_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: DEPTH_URL is not configured.\n" +
        "Unset it to use the default NORS aggregated report, or set it to a\n" +
        "file:// path of a custom bathymetry export (with DEPTH_SOURCE=custom).\n" +
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

  console.log(
    `Fetching depth dataset from: ${DEPTH_URL} ` +
      `(source: ${DEPTH_SOURCE_IS_NORS ? "NORS aggregated" : "custom export"})`,
  );
  const res = await fetch(DEPTH_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch dataset: ${res.status} ${res.statusText}`);
  }

  const rows: DepthRow[] = [];
  let errors = 0;
  let skipped = 0;

  if (DEPTH_SOURCE_IS_NORS) {
    // Default path: the NORS aggregated report — one record per lake, keyed by
    // eU_CD, with maxDjup.  mapNorsDepthRecord returns null for rows without a
    // usable eU_CD + maxDjup (most NORS rows lack a depth value).
    const records = (await res.json()) as NorsDepthRecord[];
    console.log(`Fetched ${records.length} NORS records.`);
    for (const record of records) {
      const row = mapNorsDepthRecord(record);
      if (row === null) {
        skipped++;
        continue;
      }
      rows.push(row);
    }
  } else {
    // Custom export path: records already match DepthRecord.
    const records = (await res.json()) as DepthRecord[];
    console.log(`Fetched ${records.length} records.`);
    for (const record of records) {
      try {
        rows.push(mapDepthRecord(record));
      } catch (err) {
        errors++;
        console.warn(`Skipping record: ${(err as Error).message}`);
      }
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

  console.log(
    `\nDone. Imported: ${rows.length}, No depth: ${skipped}, Skipped (errors): ${errors}`,
  );

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
