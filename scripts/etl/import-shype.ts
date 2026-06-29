/**
 * ETL stub: import S-HYPE modeled water temperatures from SMHI Vattenwebb.
 *
 * Run:  pnpm etl:shype
 *
 * ## Status
 * STUB — the Vattenwebb S-HYPE export is not yet wired.  The script logs a
 * clear error and exits 1 if `SHYPE_URL` is not configured.  Once the export
 * URL is known, implement the mapper and remove the TODO guards.
 *
 * See scripts/etl/README.md (S-HYPE section) for dataset notes and the
 * placeholder URL pattern.
 *
 * ## Idempotency
 * When wired, the script should upsert on `lake_id` PK (ON CONFLICT DO UPDATE)
 * so re-runs are safe.
 *
 * ## Architecture
 * Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
 * time.  The runtime path — `src/lib/water/temp.ts#waterTempFor` — reads from
 * the `water_temp` table; if no row exists the estimate fallback is used.
 */

// ---------------------------------------------------------------------------
// URL placeholder — operator must supply the real download URL.
// See scripts/etl/README.md (S-HYPE section) for the Vattenwebb export path.
// ---------------------------------------------------------------------------
const SHYPE_URL =
  process.env.SHYPE_URL ??
  "<TODO: SMHI Vattenwebb S-HYPE sub-catchment water-temperature export URL — see scripts/etl/README.md>";

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions — adapt once the real S-HYPE export schema is known.
// ---------------------------------------------------------------------------

/**
 * Expected shape of one record from the S-HYPE export.
 * Field names are placeholders — verify against the actual dataset.
 */
export interface ShypeRecord {
  /** Sub-catchment / lake identifier (must match `lakes.id`). */
  lakeId: string;
  /** Modeled water temperature in °C. */
  tempC: number;
  /** ISO-8601 timestamp of this model output. */
  asOf: string;
}

/** Row shape matching the `water_temp` Drizzle table. */
export interface WaterTempRow {
  lakeId: string;
  tempC: number;
  asOf: Date | null;
}

// ---------------------------------------------------------------------------
// Pure mapper — unit-test this once the real schema is known.
// ---------------------------------------------------------------------------

/**
 * Map a single S-HYPE record to a `water_temp` table row.
 * Throws if required fields are missing.
 */
export function mapRecordToWaterTemp(record: ShypeRecord): WaterTempRow {
  if (!record.lakeId) {
    throw new Error("S-HYPE record is missing required lakeId.");
  }
  if (typeof record.tempC !== "number" || !Number.isFinite(record.tempC)) {
    throw new Error(
      `Invalid tempC on S-HYPE record for lakeId: ${record.lakeId}`,
    );
  }

  return {
    lakeId: record.lakeId,
    tempC: record.tempC,
    asOf: record.asOf ? new Date(record.asOf) : null,
  };
}

// ---------------------------------------------------------------------------
// Script body — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (SHYPE_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: SHYPE_URL is not configured.\n" +
        "Set the SHYPE_URL environment variable to the SMHI Vattenwebb S-HYPE\n" +
        "sub-catchment water-temperature export URL.\n" +
        "See scripts/etl/README.md (S-HYPE section) for details.",
    );
    process.exit(1);
  }

  // Lazy imports — kept out of module scope so tests never touch DB or env.
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { sql } = await import("drizzle-orm");
  const { waterTemp } = await import("@/shared/db/schema");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const pg = postgres(databaseUrl);
  const db = drizzle(pg);

  console.log(`Fetching S-HYPE dataset from: ${SHYPE_URL}`);
  const res = await fetch(SHYPE_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch dataset: ${res.status} ${res.statusText}`);
  }

  // TODO: parse the actual S-HYPE export format once it is known.
  // The Vattenwebb export may be JSON, CSV, or another format.
  const records: ShypeRecord[] = (await res.json()) as ShypeRecord[];
  console.log(`Fetched ${records.length} records.`);

  const rows: WaterTempRow[] = [];
  let errors = 0;

  for (const record of records) {
    try {
      rows.push(mapRecordToWaterTemp(record));
    } catch (err) {
      errors++;
      console.warn(`Skipping record: ${(err as Error).message}`);
    }
  }

  // H8: chunk so a large INSERT can't exceed Postgres' 65,535 bind-param cap.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(waterTemp)
      .values(chunk)
      .onConflictDoUpdate({
        target: waterTemp.lakeId,
        set: {
          tempC: sql`excluded.temp_c`,
          asOf: sql`excluded.as_of`,
        },
      });
  }

  console.log(`\nDone. Imported: ${rows.length}, Skipped (errors): ${errors}`);

  await pg.end();
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("import-shype.ts") ||
    process.argv[1].endsWith("import-shype.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
