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
// Source — the VISS (Vatteninformationssystem Sverige) open water register.
// VERIFIED live 2026-07-02 against the real API response.
//
// SMHI's SVAR lake geometries are Lantmäteriet-derived and are NOT open data,
// so there is no open SVAR WFS.  VISS is the open register of ~7 300 lake
// water-bodies (WaterCategory LW) keyed by EU_CD (the same code used as
// lakes.id), published by Länsstyrelserna.  Requires a free apikey.
//
// Three VISS "methods" are used (each returns a flat JSON array):
//   waters         — the lakes themselves (EU_CD, Name, area, Coordinates)
//   municipalities — MunicipalityCode → Name + CountyCode
//   counties       — CountyCode → Name
// The two lookup methods resolve the numeric municipality codes the `waters`
// response carries into human-readable municipality/county names (100% of the
// 285 distinct lake municipality codes resolve).
//
// Coordinates: the `waters` response carries a Coordinates[] with THREE formats
// (SWEREF99, RT90, LatLong).  We pick Format === "LatLong" — that entry is
// already WGS84 decimal degrees (XValue = lat, YValue = lon, decimal COMMA), so
// NO SWEREF99TM→WGS84 reprojection is needed for the lakes table.
//
// VISS_API_URL defaults to the documented base; the apikey is read from
// VISS_APIKEY and appended at fetch time so the secret never lives in a URL
// constant or a log line.
// ---------------------------------------------------------------------------
const VISS_API_BASE =
  process.env.VISS_API_URL ?? "https://viss.lansstyrelsen.se/api";

const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions — VISS response shapes, VERIFIED against the live API.
// ---------------------------------------------------------------------------

/** One coordinate triple from a VISS water's Coordinates[] array. */
export interface VissCoordinate {
  /** Northing / latitude, as a string with a DECIMAL COMMA. */
  XValue: string;
  /** Easting / longitude, as a string with a DECIMAL COMMA. */
  YValue: string;
  /** "SWEREF99" | "RT90" | "LatLong" — we only use "LatLong" (WGS84). */
  Format: string;
}

/** One water body from VISS `method=waters&watercategory=LW`. */
export interface VissWater {
  /** EU WFD water-body code, e.g. "SE656250-138625". Used as the PK. */
  EU_CD?: string;
  /** Water-body name. May be absent/blank for unnamed bodies. */
  Name?: string | null;
  /** Surface area in KM² (NOT hectares — multiply by 100). */
  SurfaceAreaKM2?: number | null;
  /** Municipality codes this water body touches (first is used as primary). */
  Municipalites?: string[] | null;
  /** All coordinate formats for the centroid. */
  Coordinates?: VissCoordinate[] | null;
}

/** One row from VISS `method=municipalities`. */
export interface VissMunicipality {
  MunicipalityCode: string;
  Name: string;
  CountyCode: string | null;
}

/** One row from VISS `method=counties`. */
export interface VissCounty {
  CountyCode: string;
  Name: string;
}

/** Resolved code→name lookups, built once from the two lookup methods. */
export interface VissLookups {
  /** MunicipalityCode → { name, countyCode }. */
  municipality: Map<string, { name: string; countyCode: string | null }>;
  /** CountyCode → county name. */
  county: Map<string, string>;
}

/** Fallback text when a municipality/county cannot be resolved (notNull cols). */
const UNKNOWN_PLACE = "Okänd";

/** Row shape matching the `lakes` Drizzle table. */
export interface LakeRow {
  id: string;
  name: string | null;
  municipality: string;
  county: string;
  lat: number;
  lon: number;
  areaHa: number;
  /** VISS EU_CD = the lake id; set so MVM/NORS can join even before the LM ETL. */
  euCd: string;
  source: "viss";
}

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in import-svar.test.ts
// ---------------------------------------------------------------------------

/** Parse a VISS decimal-COMMA numeric string ("62,168…") to a number. */
export function parseVissNumber(value: string | undefined | null): number {
  if (value === undefined || value === null) return Number.NaN;
  return Number.parseFloat(value.replace(",", "."));
}

/**
 * Pick the WGS84 (LatLong) centroid from a VISS Coordinates[] array.
 * Returns { lat, lon } or null when no LatLong entry / unparseable.
 * XValue is latitude, YValue is longitude (VISS convention).
 */
export function pickLatLong(
  coordinates: VissCoordinate[] | null | undefined,
): { lat: number; lon: number } | null {
  const ll = (coordinates ?? []).find((c) => c.Format === "LatLong");
  if (!ll) return null;
  const lat = parseVissNumber(ll.XValue);
  const lon = parseVissNumber(ll.YValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Map one VISS water body + the resolved code→name lookups to a `lakes` row.
 *
 * Returns null (skip, not throw) when the water body lacks the data the lakes
 * table requires — no EU_CD, no LatLong centroid, or no area — so one bad row
 * can't abort the whole seed.  Municipality/county fall back to "Okänd" when a
 * code is absent or unresolved (the columns are notNull).
 */
export function mapWaterToLake(
  water: VissWater,
  lookups: VissLookups,
): LakeRow | null {
  const id = water.EU_CD?.trim();
  if (!id) return null;

  const coord = pickLatLong(water.Coordinates);
  if (!coord) return null;

  const areaKm2 = water.SurfaceAreaKM2;
  if (areaKm2 === undefined || areaKm2 === null || !Number.isFinite(areaKm2)) {
    return null;
  }

  // Resolve the primary municipality code → name + county name.
  const muniCode = water.Municipalites?.[0];
  const muni = muniCode ? lookups.municipality.get(muniCode) : undefined;
  const municipality = muni?.name ?? UNKNOWN_PLACE;
  const county =
    (muni?.countyCode ? lookups.county.get(muni.countyCode) : undefined) ??
    UNKNOWN_PLACE;

  return {
    id,
    name: water.Name?.trim() || null,
    municipality,
    county,
    lat: coord.lat,
    lon: coord.lon,
    areaHa: areaKm2 * 100, // km² → hectares
    euCd: id, // VISS id IS the EU WFD code
    source: "viss",
  };
}

// ---------------------------------------------------------------------------
// Script body — only runs when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

/**
 * Fetch one VISS method as JSON.  The apikey is appended here (never stored in
 * a URL constant), and the logged URL is redacted so the key can't leak.
 */
async function fetchViss<T>(
  method: string,
  extraParams: string,
  apikey: string,
): Promise<T> {
  const url = `${VISS_API_BASE}?method=${method}${extraParams}&format=json&apikey=${encodeURIComponent(apikey)}`;
  const redacted = url.replace(/apikey=[^&]*/i, "apikey=***");
  console.log(`Fetching VISS ${method} from: ${redacted}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch VISS ${method}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const apikey = process.env.VISS_APIKEY;
  if (!apikey) {
    console.error(
      "ERROR: VISS_APIKEY is not set.\n" +
        "Register for a free VISS apikey at https://viss.lansstyrelsen.se/api\n" +
        "and export it as VISS_APIKEY.  See scripts/etl/README.md (SVAR section).",
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

  // 1. Fetch the two lookup tables (municipalities, counties) and build maps.
  const municipalities = await fetchViss<VissMunicipality[]>(
    "municipalities",
    "",
    apikey,
  );
  const counties = await fetchViss<VissCounty[]>("counties", "", apikey);
  const lookups: VissLookups = {
    municipality: new Map(
      municipalities.map((m) => [
        m.MunicipalityCode,
        { name: m.Name, countyCode: m.CountyCode },
      ]),
    ),
    county: new Map(counties.map((c) => [c.CountyCode, c.Name])),
  };
  console.log(
    `Loaded ${lookups.municipality.size} municipalities, ${lookups.county.size} counties.`,
  );

  // 2. Fetch the lake water bodies (WaterCategory LW).
  const waters = await fetchViss<VissWater[]>(
    "waters",
    "&watercategory=LW",
    apikey,
  );
  console.log(`Fetched ${waters.length} water bodies.`);

  let imported = 0;
  let unnamed = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < waters.length; i += BATCH_SIZE) {
    const batch = waters.slice(i, i + BATCH_SIZE);
    const rows: LakeRow[] = [];

    for (const water of batch) {
      const row = mapWaterToLake(water, lookups);
      if (row === null) {
        errors++;
        continue;
      }
      rows.push(row);
      if (row.name === null) unnamed++;
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
            euCd: sql`excluded.eu_cd`,
            source: sql`excluded.source`,
          },
        });
      imported += rows.length;
    }

    console.log(
      `  Progress: ${Math.min(i + BATCH_SIZE, waters.length)} / ${waters.length}`,
    );
  }

  console.log(
    `\nDone. Imported: ${imported}, Unnamed: ${unnamed}, Skipped (no EU_CD/coord/area): ${errors}`,
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
