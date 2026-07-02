/**
 * One-time ETL: seed SMHI metobs station lists (air pressure + air temperature)
 * into the `metobs_station` table.
 *
 * Run:  pnpm etl:metobs-stations
 *
 * The script is idempotent — re-running it upserts all rows on the composite
 * (id, parameter) PK without creating duplicates.
 *
 * See scripts/etl/README.md for endpoint notes and operator instructions.
 *
 * SMHI metobs parameter ids:
 *   - air pressure    → parameter id 9  → stored as 'pressure'
 *   - air temperature → parameter id 1  → stored as 'temp'
 */

// ---------------------------------------------------------------------------
// SMHI Open Data metobs endpoint — VERIFIED against the live API 2026-07-01.
//
// The station list for a parameter is the parameter node itself; it carries a
// `station` array.  There is NO separate `/station.json` sub-resource.  URL
// pattern (from the api.json entry point):
//   /api/version/{version}/parameter/{parameter}.json
// Live-checked: GET .../parameter/1.json → { ..., "station": [ { id, name,
//   latitude, longitude, active, from, to }, ... ] } (1000 stations for p=1).
// Docs: https://opendata.smhi.se/apidocs/metobs/ ; entry: /api.json
// ---------------------------------------------------------------------------
const METOBS_BASE =
  process.env.METOBS_BASE ?? "https://opendata-download-metobs.smhi.se";

const METOBS_STATION_URL =
  process.env.METOBS_STATION_URL ?? "/api/version/1.0/parameter/{p}.json";

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// SMHI metobs parameter configuration
// ---------------------------------------------------------------------------

/** The two weather parameters we seed. */
const METOBS_PARAMETERS = [
  { id: 9, label: "pressure" as const },
  { id: 1, label: "temp" as const },
] satisfies Array<{ id: number; label: MetobsParameter }>;

/** Discriminated union of the parameter labels stored in the DB. */
export type MetobsParameter = "pressure" | "temp";

// ---------------------------------------------------------------------------
// Type definitions — station shape as returned by SMHI metobs station list.
// Field names follow the SMHI Open Data API documentation at:
//   https://opendata.smhi.se/apidocs/metobs/
// ---------------------------------------------------------------------------

/** Raw station object from the SMHI metobs station-list JSON response. */
export interface RawMetobsStation {
  /** Numeric station id. */
  id?: number | string;
  /** Station display name. */
  name?: string;
  /** Latitude in WGS84 decimal degrees. */
  latitude?: number;
  /** Longitude in WGS84 decimal degrees. */
  longitude?: number;
  /** Whether the station is currently active (informational only). */
  active?: boolean;
  /** Coverage start timestamp (ms epoch). */
  from?: number;
  /** Coverage end timestamp (ms epoch). */
  to?: number;
}

/** Row shape matching the `metobsStations` Drizzle table. */
export interface MetobsStationRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  parameter: MetobsParameter;
}

// ---------------------------------------------------------------------------
// Pure mapper — unit-tested in import-metobs-stations.test.ts
// ---------------------------------------------------------------------------

/**
 * Map a single raw SMHI metobs station object to a `metobs_station` table row.
 *
 * Throws if any required property (id, name, latitude, longitude) is missing.
 */
export function mapStation(
  raw: RawMetobsStation,
  parameter: MetobsParameter,
): MetobsStationRow {
  if (raw.id === undefined || raw.id === null || raw.id === "") {
    throw new Error("metobs station is missing required id field");
  }
  if (!raw.name) {
    throw new Error(`metobs station ${raw.id} is missing required name field`);
  }
  if (raw.latitude === undefined || raw.latitude === null) {
    throw new Error(
      `metobs station ${raw.id} is missing required latitude field`,
    );
  }
  if (raw.longitude === undefined || raw.longitude === null) {
    throw new Error(
      `metobs station ${raw.id} is missing required longitude field`,
    );
  }

  return {
    id: String(raw.id),
    name: raw.name,
    lat: raw.latitude,
    lon: raw.longitude,
    parameter,
  };
}

// ---------------------------------------------------------------------------
// Script body — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Validate URL placeholder
  if (METOBS_STATION_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: METOBS_STATION_URL is not configured.\n" +
        "Set the METOBS_STATION_URL environment variable to the SMHI metobs\n" +
        "station-list endpoint pattern containing '{p}' for the parameter id.\n" +
        "See scripts/etl/README.md for details.",
    );
    process.exit(1);
  }

  // Lazy imports — kept out of module scope so tests never touch DB or env.
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { sql } = await import("drizzle-orm");
  const { metobsStations } = await import("@/shared/db/schema");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const pg = postgres(databaseUrl);
  const db = drizzle(pg);

  let totalImported = 0;
  let totalErrors = 0;

  for (const { id: parameterId, label } of METOBS_PARAMETERS) {
    const url = `${METOBS_BASE}${METOBS_STATION_URL.replace("{p}", String(parameterId))}`;
    console.log(
      `\nFetching metobs stations for '${label}' (parameter ${parameterId}) from: ${url}`,
    );

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch station list for parameter ${parameterId}: ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as
      | { station?: RawMetobsStation[] }
      | RawMetobsStation[];
    const rawStations: RawMetobsStation[] = Array.isArray(body)
      ? body
      : (body.station ?? []);

    console.log(`  Fetched ${rawStations.length} raw stations.`);

    let imported = 0;
    let errors = 0;

    // Process in batches
    for (let i = 0; i < rawStations.length; i += BATCH_SIZE) {
      const batch = rawStations.slice(i, i + BATCH_SIZE);
      const rows: MetobsStationRow[] = [];

      for (const raw of batch) {
        try {
          rows.push(mapStation(raw, label));
        } catch (err) {
          errors++;
          console.warn(`  Skipping station: ${(err as Error).message}`);
        }
      }

      if (rows.length > 0) {
        await db
          .insert(metobsStations)
          .values(rows)
          .onConflictDoUpdate({
            target: [metobsStations.id, metobsStations.parameter],
            set: {
              // `excluded.<col>` refers to the PostgreSQL pseudo-table of the
              // proposed row; column names here are DB column names (snake_case),
              // not Drizzle field names.  Confirmed against schema.ts:
              //   name→name, lat→lat, lon→lon
              name: sql`excluded.name`,
              lat: sql`excluded.lat`,
              lon: sql`excluded.lon`,
            },
          });
        imported += rows.length;
      }

      console.log(
        `  Progress: ${Math.min(i + BATCH_SIZE, rawStations.length)} / ${rawStations.length}`,
      );
    }

    console.log(
      `  Done '${label}': imported ${imported}, skipped (errors): ${errors}`,
    );
    totalImported += imported;
    totalErrors += errors;
  }

  console.log(
    `\nAll done. Total imported: ${totalImported}, Total skipped (errors): ${totalErrors}`,
  );

  await pg.end();
}

// Only run when invoked as a script, not when imported by tests
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("import-metobs-stations.ts") ||
    process.argv[1].endsWith("import-metobs-stations.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
