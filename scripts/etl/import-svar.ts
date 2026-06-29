/**
 * One-time ETL: import Swedish water bodies from the SMHI SVAR WFS dataset
 * into the `lakes` table.
 *
 * Run:  pnpm etl:svar
 *
 * The script is idempotent — re-running it upserts all rows without duplicates.
 *
 * See scripts/etl/README.md for dataset URL, field-name assumptions and
 * operator instructions.
 */

// ---------------------------------------------------------------------------
// URL placeholder — operator must supply the real download URL (or a path to
// a locally-downloaded GeoJSON file).  See scripts/etl/README.md.
// ---------------------------------------------------------------------------
const SVAR_WFS_URL =
  process.env.SVAR_WFS_URL ??
  "<TODO: SMHI Vattenwebb SVAR WFS download URL — see scripts/etl/README.md>";

const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions — WFS feature shape as returned by SMHI Vattenwebb SVAR.
// Field names follow the SVAR attribute table documented at:
//   https://vattenwebb.smhi.se/  (Ytvattenförekomster / MS_WB_AREA layer)
// ---------------------------------------------------------------------------

/** Raw GeoJSON properties for one SVAR water-body feature. */
export interface SvarFeatureProperties {
  /** EU WFD water-body code, e.g. "SE656250-138625". Used as the PK. */
  MS_CD?: string;
  /** Swedish name of the water body. May be absent for unnamed bodies. */
  MS_NAME?: string;
  /** Municipality name (kommunnamn). */
  KOMMUNNAMN?: string;
  /** County name (lännamn). */
  LANNAMN?: string;
  /**
   * Centroid northing.  The dataset may deliver coordinates in SWEREF99TM
   * (metres) or as WGS84 decimal degrees depending on the WFS request CRS.
   * The script stores the raw values; callers must be aware of the CRS used.
   */
  CENTROID_N?: number;
  /** Centroid easting (see CENTROID_N). */
  CENTROID_E?: number;
  /** Water body area in hectares. */
  AREA_HA?: number;
}

export interface SvarFeature {
  type: "Feature";
  id?: string;
  geometry: unknown;
  properties: SvarFeatureProperties;
}

/** Row shape matching the `lakes` Drizzle table. */
export interface LakeRow {
  id: string;
  name: string | null;
  municipality: string;
  county: string;
  lat: number;
  lon: number;
  areaHa: number;
}

// ---------------------------------------------------------------------------
// Pure mapper — unit-tested in import-svar.test.ts
// ---------------------------------------------------------------------------

/**
 * Map a single SVAR WFS feature to a `lakes` table row.
 *
 * Throws if any required property (MS_CD, KOMMUNNAMN, LANNAMN, CENTROID_N,
 * CENTROID_E, AREA_HA) is missing.
 */
export function mapFeatureToLake(feature: SvarFeature): LakeRow {
  const p = feature.properties;

  if (!p.MS_CD) {
    throw new Error(
      `SVAR feature is missing required MS_CD (water-body code). Feature id: ${feature.id ?? "unknown"}`,
    );
  }
  if (p.KOMMUNNAMN === undefined || p.KOMMUNNAMN === null) {
    throw new Error(`Missing KOMMUNNAMN on feature ${p.MS_CD}`);
  }
  if (p.LANNAMN === undefined || p.LANNAMN === null) {
    throw new Error(`Missing LANNAMN on feature ${p.MS_CD}`);
  }
  if (p.CENTROID_N === undefined || p.CENTROID_N === null) {
    throw new Error(`Missing CENTROID_N on feature ${p.MS_CD}`);
  }
  if (p.CENTROID_E === undefined || p.CENTROID_E === null) {
    throw new Error(`Missing CENTROID_E on feature ${p.MS_CD}`);
  }
  if (p.AREA_HA === undefined || p.AREA_HA === null) {
    throw new Error(`Missing AREA_HA on feature ${p.MS_CD}`);
  }

  return {
    id: p.MS_CD,
    name: p.MS_NAME?.trim() || null,
    municipality: p.KOMMUNNAMN,
    county: p.LANNAMN,
    lat: p.CENTROID_N,
    lon: p.CENTROID_E,
    areaHa: p.AREA_HA,
  };
}

// ---------------------------------------------------------------------------
// Script body — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Validate URL placeholder
  if (SVAR_WFS_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: SVAR_WFS_URL is not configured.\n" +
        "Set the SVAR_WFS_URL environment variable to the SMHI Vattenwebb WFS\n" +
        "download URL (or a local file:// path to a downloaded GeoJSON file).\n" +
        "See scripts/etl/README.md for details.",
    );
    process.exit(1);
  }

  // Lazy imports — kept out of module scope so tests never touch DB or env.
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { sql } = await import("drizzle-orm");
  const { lakes } = await import("@/shared/db/schema");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is not set.");
    process.exit(1);
  }

  const pg = postgres(databaseUrl);
  const db = drizzle(pg);

  console.log(`Fetching SVAR dataset from: ${SVAR_WFS_URL}`);
  const res = await fetch(SVAR_WFS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch dataset: ${res.status} ${res.statusText}`);
  }

  const geojson = (await res.json()) as {
    type: string;
    features: SvarFeature[];
  };

  const features: SvarFeature[] = geojson.features ?? [];
  console.log(`Fetched ${features.length} features.`);

  let imported = 0;
  let unnamed = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < features.length; i += BATCH_SIZE) {
    const batch = features.slice(i, i + BATCH_SIZE);
    const rows: LakeRow[] = [];

    for (const feature of batch) {
      try {
        const row = mapFeatureToLake(feature);
        rows.push(row);
        if (row.name === null) unnamed++;
      } catch (err) {
        errors++;
        console.warn(`Skipping feature: ${(err as Error).message}`);
      }
    }

    if (rows.length > 0) {
      await db
        .insert(lakes)
        .values(rows)
        .onConflictDoUpdate({
          target: lakes.id,
          set: {
            // `excluded.<col>` refers to the PostgreSQL pseudo-table of the
            // proposed row; column names here are DB column names (snake_case),
            // not Drizzle field names.  Confirmed against schema.ts:
            //   name→name, municipality→municipality, county→county,
            //   lat→lat, lon→lon, areaHa→area_ha
            name: sql`excluded.name`,
            municipality: sql`excluded.municipality`,
            county: sql`excluded.county`,
            lat: sql`excluded.lat`,
            lon: sql`excluded.lon`,
            areaHa: sql`excluded.area_ha`,
          },
        });
      imported += rows.length;
    }

    console.log(
      `  Progress: ${Math.min(i + BATCH_SIZE, features.length)} / ${features.length}`,
    );
  }

  console.log(
    `\nDone. Imported: ${imported}, Unnamed: ${unnamed}, Skipped (errors): ${errors}`,
  );

  await pg.end();
}

// Only run when invoked as a script, not when imported by tests
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("import-svar.ts") ||
    process.argv[1].endsWith("import-svar.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
