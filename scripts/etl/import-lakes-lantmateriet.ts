/**
 * ETL: build the lake universe from Lantmäteriet Topografi 50 (CC0).
 *
 * Run:  pnpm etl:lakes
 *
 * Replaces VISS (~7 250 WFD-classified lakes) as the lake universe with the full
 * named Swedish lake set from Lantmäteriet Topografi vektor (~tens of thousands
 * of named lakes). See docs/plans/2026-07-02-lantmateriet-full-lake-coverage.md.
 *
 * Pipeline:
 *   1. Ensure the delivery files are on disk (mark_sverige.zip = lake polygons in
 *      the `mark` table; text_sverige.zip = names in the `text` table). Download
 *      them first with `pnpm etl:lm-download` if missing.
 *   2. Unzip each to its GeoPackage.
 *   3. ogr2ogr the needed layers into PostGIS staging tables (lm_mark, lm_text)
 *      — run via the GDAL Docker image so no host GDAL install is needed.
 *   4. In SQL: filter `mark` to lake/water polygons, spatial-join the nearest
 *      name, compute WGS84 centroid + area, filter to named lakes >= min area.
 *   5. Upsert into `lakes` with source='lantmateriet'.
 *   6. Crosswalk: match each Lantmäteriet lake to a VISS EU_CD (point-in-polygon
 *      / nearest centroid) and fill lakes.eu_cd so MVM/NORS keep joining.
 *
 * Env: DATABASE_URL, LM_DOWNLOAD_DIR (default .lm-data), optional
 * LM_MIN_AREA_HA (default 1), LM_GDAL_IMAGE, LM_PGHOST (host as seen from the
 * GDAL container, default host.docker.internal).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DOWNLOAD_DIR = process.env.LM_DOWNLOAD_DIR ?? ".lm-data";
const GDAL_IMAGE =
  process.env.LM_GDAL_IMAGE ?? "ghcr.io/osgeo/gdal:alpine-small-latest";
/** DB host as seen from inside the GDAL container (Mac/Win: host.docker.internal). */
const PGHOST_FROM_CONTAINER = process.env.LM_PGHOST ?? "host.docker.internal";
const MIN_AREA_HA = Number.parseFloat(process.env.LM_MIN_AREA_HA ?? "1");

/** Parse a postgres:// URL into ogr2ogr PG connection params. */
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

/**
 * Ensure the GeoPackage for a delivery zip exists in DOWNLOAD_DIR, unzipping if
 * needed. Returns the .gpkg path. Skips unzipping when the .gpkg is already
 * present (a re-run, or the zip was already extracted + cleaned up).
 */
function ensureGpkg(zipName: string): string {
  const gpkgPath = join(DOWNLOAD_DIR, zipName.replace(/\.zip$/, ".gpkg"));
  if (existsSync(gpkgPath)) {
    console.log(`Using existing ${gpkgPath}`);
    return gpkgPath;
  }
  const zipPath = join(DOWNLOAD_DIR, zipName);
  if (!existsSync(zipPath)) {
    throw new Error(
      `Missing ${gpkgPath} and ${zipPath}. Download first: pnpm etl:lm-download ${zipName}`,
    );
  }
  const r = spawnSync("unzip", ["-o", zipPath, "-d", DOWNLOAD_DIR], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`unzip ${zipName} failed`);
  return gpkgPath;
}

/**
 * Load one GeoPackage layer into a PostGIS staging table via the GDAL container.
 * The download dir is bind-mounted read-only; ogr2ogr writes to Postgres over
 * the network. -nlt PROMOTE_TO_MULTI keeps mixed polygon/multipolygon layers.
 */
function ogr2ogrLoad(
  gpkgPath: string,
  layer: string,
  targetTable: string,
  db: ReturnType<typeof parseDbUrl>,
): void {
  const containerGpkg = `/data/${gpkgPath.split("/").pop()}`;
  const pg = `PG:host=${PGHOST_FROM_CONTAINER} port=${db.port} dbname=${db.db} user=${db.user} password=${db.password}`;
  // Docker requires an ABSOLUTE host path for a bind mount; a relative path like
  // ".lm-data" is interpreted as a (invalid) named volume.
  const mountDir = resolve(DOWNLOAD_DIR);
  const args = [
    "run",
    "--rm",
    "-v",
    `${mountDir}:/data:ro`,
    GDAL_IMAGE,
    "ogr2ogr",
    "-f",
    "PostgreSQL",
    pg,
    containerGpkg,
    layer,
    "-nln",
    targetTable,
    "-overwrite",
    "-lco",
    "GEOMETRY_NAME=geom",
    "-lco",
    "SPATIAL_INDEX=GIST",
    "-nlt",
    "PROMOTE_TO_MULTI",
    "-t_srs",
    "EPSG:3006", // keep source CRS; we reproject explicitly in SQL
  ];
  console.log(`ogr2ogr → ${targetTable} (layer ${layer})`);
  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ogr2ogr load of ${layer} failed`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }
  const db = parseDbUrl(databaseUrl);

  // 1–2. Unzip the delivery files (download them first with etl:lm-download).
  const markGpkg = ensureGpkg("mark_sverige.zip");
  const textGpkg = ensureGpkg("text_sverige.zip");
  console.log(`Unzipped: ${markGpkg}, ${textGpkg}`);

  // Discover the real layer names (GeoPackage layer != file name in general).
  const markLayer = process.env.LM_MARK_LAYER ?? "mark";
  // The name layer inside text_sverige.gpkg is `textpunkt` (point labels).
  const textLayer = process.env.LM_TEXT_LAYER ?? "textpunkt";

  // 3. Load the mark (land-cover polygons) + text (names) layers into staging.
  ogr2ogrLoad(markGpkg, markLayer, "lm_mark", db);
  ogr2ogrLoad(textGpkg, textLayer, "lm_text", db);

  // 4–6. The SQL transform (filter mark→lakes, join names, centroid/reproject,
  // upsert into lakes, VISS crosswalk) lives in a separate module.
  const { transformLmLakes } = await import("./lm-transform");
  await transformLmLakes({ databaseUrl, minAreaHa: MIN_AREA_HA });

  console.log("\nLantmäteriet lake ETL complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
