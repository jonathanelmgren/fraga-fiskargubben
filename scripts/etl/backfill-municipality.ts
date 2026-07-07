/**
 * ETL: backfill municipality/county for Lantmäteriet lakes ("Okänd" rows).
 *
 * Run:  pnpm etl:lm-municipality
 *
 * The Lantmäteriet Topografi 50 mark layer carries no administrative info, and
 * its administrativindelning theme has boundary LINES only (no kommun-coded
 * polygons) — so the LM lake import leaves municipality/county = 'Okänd' for
 * every non-VISS-crosswalked lake (~20k rows). That breaks the resolver's
 * clarify loop: users answer "vilken kommun?" with a kommun the register
 * cannot match ("Marks kommun", "Stockholm" → gave up).
 *
 * Source here: SCB "Digitala gränser" (CC0, no account) — simplified kommun +
 * län polygons in SWEREF99TM. Simplified is fine for assigning a lake CENTROID
 * to a kommun; border lakes get one of their two kommuner, the same ambiguity
 * Lantmäteriet's own tagging has (the resolver already reasons about
 * grannkommuner).
 *
 * Pipeline:
 *   1. Expect the SCB shapefiles unzipped in LM_DOWNLOAD_DIR/scb
 *      (Kommun_Sweref99TM.shp + Lan_Sweref99TM_region.shp). Download:
 *      https://www.scb.se/hitta-statistik/regional-statistik-och-kartor/
 *      regionala-indelningar/digitala-granser/ → "shape svenska" zip.
 *   2. ogr2ogr both into PostGIS staging (scb_kommun, scb_lan) via the GDAL
 *      container (same pattern as import-lakes-lantmateriet).
 *   3. UPDATE lakes: point-in-polygon on the lake centroid; nearest-kommun
 *      fallback within 5 km for centroids the simplified polygons miss.
 *      Only rows with municipality = 'Okänd' are touched — VISS-curated
 *      values are never overwritten.
 *
 * County naming: SCB LnNamn is the possessive form ("Stockholms", "Dalarnas");
 * stripping a trailing "s" yields exactly the VISS format already in `lakes`
 * ("Stockholm", "Dalarna") — verified against all 21 län.
 *
 * Env: DATABASE_URL, LM_DOWNLOAD_DIR (default .lm-data), LM_GDAL_IMAGE,
 * LM_PGHOST (DB host as seen from the GDAL container).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DOWNLOAD_DIR = process.env.LM_DOWNLOAD_DIR ?? ".lm-data";
const SCB_DIR = join(DOWNLOAD_DIR, "scb");
const GDAL_IMAGE =
  process.env.LM_GDAL_IMAGE ?? "ghcr.io/osgeo/gdal:alpine-small-latest";
const PGHOST_FROM_CONTAINER = process.env.LM_PGHOST ?? "host.docker.internal";

/** Nearest-kommun fallback radius (metres) for centroids the simplified SCB
 * polygons miss (coastal/border simplification artifacts). */
const FALLBACK_RADIUS_M = 5000;

function parseDbUrl(url: string): {
  host: string;
  port: string;
  db: string;
  user: string;
  password: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || "5432",
    db: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

/** Load one shapefile into a PostGIS staging table via the GDAL container.
 * SCB ships an unnamed SWEREF99TM SRS — assign EPSG:3006 explicitly. */
function ogr2ogrLoad(
  shpName: string,
  targetTable: string,
  db: ReturnType<typeof parseDbUrl>,
): void {
  const pg = `PG:host=${PGHOST_FROM_CONTAINER} port=${db.port} dbname=${db.db} user=${db.user} password=${db.password}`;
  const args = [
    "run",
    "--rm",
    "-v",
    `${resolve(SCB_DIR)}:/data:ro`,
    GDAL_IMAGE,
    "ogr2ogr",
    "-f",
    "PostgreSQL",
    pg,
    `/data/${shpName}`,
    "-nln",
    targetTable,
    "-overwrite",
    "-lco",
    "GEOMETRY_NAME=geom",
    "-lco",
    "SPATIAL_INDEX=GIST",
    "-nlt",
    "PROMOTE_TO_MULTI",
    "-a_srs",
    "EPSG:3006",
  ];
  console.log(`ogr2ogr → ${targetTable} (${shpName})`);
  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ogr2ogr load of ${shpName} failed`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }
  const db = parseDbUrl(databaseUrl);

  const kommunShp = "Kommun_Sweref99TM.shp";
  const lanShp = "Lan_Sweref99TM_region.shp";
  for (const f of [kommunShp, lanShp]) {
    if (!existsSync(join(SCB_DIR, f))) {
      console.error(
        `ERROR: ${join(SCB_DIR, f)} missing. Download SCB "Digitala gränser" (shape svenska zip) and unzip into ${SCB_DIR}.`,
      );
      process.exit(1);
    }
  }

  ogr2ogrLoad(kommunShp, "scb_kommun", db);
  ogr2ogrLoad(lanShp, "scb_lan", db);

  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [{ before }] = await sql<{ before: number }[]>`
      SELECT COUNT(*)::int AS before FROM lakes WHERE municipality = 'Okänd'`;
    console.log(`Lakes with municipality 'Okänd' before: ${before}`);

    // County lookup: kommun code prefix (2 digits) = län code.
    // Normalize SCB's possessive LnNamn to the bare VISS form.
    await sql`DROP TABLE IF EXISTS scb_lan_lookup`;
    await sql`
      CREATE TABLE scb_lan_lookup AS
      SELECT lnkod, regexp_replace(lnnamn, 's$', '') AS county
      FROM scb_lan`;

    // Point-in-polygon on the lake centroid.
    console.log("Backfilling via point-in-polygon…");
    const pip = await sql`
      UPDATE lakes l
      SET municipality = k.knnamn,
          county = COALESCE(ln.county, 'Okänd')
      FROM scb_kommun k
      LEFT JOIN scb_lan_lookup ln ON ln.lnkod = substring(k.knkod FROM 1 FOR 2)
      WHERE l.municipality = 'Okänd'
        AND ST_Contains(
          k.geom,
          ST_Transform(ST_SetSRID(ST_MakePoint(l.lon, l.lat), 4326), 3006)
        )
      RETURNING 1`;
    console.log(`  point-in-polygon assigned: ${pip.count}`);

    // Nearest-kommun fallback for the stragglers (simplified-boundary misses).
    console.log("Backfilling stragglers via nearest kommun…");
    // (UPDATE … FROM LATERAL cannot reference the update target — compute the
    // nearest kommun per straggler in a subquery keyed by lake id instead.)
    const near = await sql`
      UPDATE lakes l
      SET municipality = nk.knnamn,
          county = COALESCE(nk.county, 'Okänd')
      FROM (
        SELECT o.id AS lake_id, x.knnamn, x.county
        FROM (
          SELECT id,
                 ST_Transform(ST_SetSRID(ST_MakePoint(lon, lat), 4326), 3006) AS pt
          FROM lakes
          WHERE municipality = 'Okänd'
        ) o
        CROSS JOIN LATERAL (
          SELECT k.knnamn, ln.county
          FROM scb_kommun k
          LEFT JOIN scb_lan_lookup ln ON ln.lnkod = substring(k.knkod FROM 1 FOR 2)
          WHERE ST_DWithin(k.geom, o.pt, ${FALLBACK_RADIUS_M})
          ORDER BY k.geom <-> o.pt
          LIMIT 1
        ) x
      ) nk
      WHERE l.id = nk.lake_id
      RETURNING 1`;
    console.log(`  nearest-kommun assigned: ${near.count}`);

    const [{ after }] = await sql<{ after: number }[]>`
      SELECT COUNT(*)::int AS after FROM lakes WHERE municipality = 'Okänd'`;
    console.log(`Lakes still 'Okänd' after: ${after}`);

    await sql`DROP TABLE IF EXISTS scb_lan_lookup, scb_kommun, scb_lan`;
    console.log("Municipality backfill complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
