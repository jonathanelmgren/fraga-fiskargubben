/**
 * SQL transform for the Lantmäteriet lake ETL (called by
 * import-lakes-lantmateriet.ts after ogr2ogr has loaded the staging tables
 * `lm_mark` and `lm_text` into PostGIS).
 *
 * Schema verified 2026-07-02 (Topografi 50 GeoPackage):
 *   lm_mark  — the `mark` layer. Lakes are rows with objekttyp = 'Sjö'. Tile
 *              splits of one lake share `vattenytaid` → aggregate by it. geom is
 *              SWEREF99TM (EPSG:3006).
 *   lm_text  — the `textpunkt` layer. Water names have textkategori =
 *              'Hydrografi'; the name text is `textstrang`.
 *
 * Steps (all in Postgres/PostGIS):
 *   1. Aggregate Sjö polygons by vattenytaid → one geometry + total area per lake.
 *   2. Centroid → reproject to WGS84 (4326) for lat/lon.
 *   3. Attach the nearest Hydrografi name whose point falls inside (or nearest
 *      to) the lake polygon.
 *   4. Filter to named lakes with area ≥ minAreaHa.
 *   5. Upsert into `lakes` (id = vattenytaid, source = 'lantmateriet').
 *      Municipality/county are 'Okänd' here — Lantmäteriet's mark layer carries
 *      neither; the VISS crosswalk (below) backfills them where a lake maps to a
 *      classified VISS body.
 *   6. Crosswalk: for each new lake, find the VISS EU_CD whose (pre-existing)
 *      VISS lake centroid falls inside the Lantmäteriet polygon (else the nearest
 *      within a tolerance) and set lakes.eu_cd, so MVM/NORS keep joining.
 */

export async function transformLmLakes(opts: {
  databaseUrl: string;
  minAreaHa: number;
}): Promise<void> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(opts.databaseUrl, { max: 1 });

  try {
    // Sanity: staging must be present (ogr2ogr ran).
    const [{ hasMark, hasText }] = await sql<
      { hasMark: string | null; hasText: string | null }[]
    >`SELECT to_regclass('lm_mark')::text AS "hasMark",
             to_regclass('lm_text')::text AS "hasText"`;
    if (!hasMark || !hasText) {
      throw new Error(
        "Staging tables lm_mark/lm_text are missing — run ogr2ogr first.",
      );
    }

    // Indexes on the staging filters/geometry make the aggregation + spatial
    // join tractable over ~300k mark rows and ~95k text points.
    await sql`CREATE INDEX IF NOT EXISTS lm_mark_objekttyp_idx ON lm_mark (objekttyp)`;
    await sql`CREATE INDEX IF NOT EXISTS lm_mark_vattenytaid_idx ON lm_mark (vattenytaid)`;
    await sql`CREATE INDEX IF NOT EXISTS lm_text_kat_idx ON lm_text (textkategori)`;

    // ── 1–2. Aggregate Sjö polygons per lake; centroid → WGS84; area in ha. ──
    // Materialize so the spatial name-join and crosswalk read it repeatedly.
    console.log("Aggregating Sjö polygons by vattenytaid…");
    await sql`DROP TABLE IF EXISTS lm_lake_agg`;
    await sql`
      CREATE TABLE lm_lake_agg AS
      SELECT
        vattenytaid AS id,
        ST_Union(geom)                                   AS geom,
        ST_Area(ST_Union(geom)) / 10000.0                AS area_ha,
        ST_Transform(ST_PointOnSurface(ST_Union(geom)), 4326) AS pt_wgs84
      FROM lm_mark
      WHERE objekttyp = 'Sjö' AND vattenytaid IS NOT NULL
      GROUP BY vattenytaid
    `;
    await sql`CREATE INDEX lm_lake_agg_geom_idx ON lm_lake_agg USING GIST (geom)`;
    const [{ n: lakeCount }] = await sql<
      { n: number }[]
    >`SELECT COUNT(*)::int n FROM lm_lake_agg`;
    console.log(`  ${lakeCount} distinct lakes aggregated.`);

    // ── 3. Nearest Hydrografi name per lake (point inside → distance 0). ──────
    // LATERAL nearest-neighbour using the GIST index (<-> operator).
    console.log("Attaching nearest Hydrografi names…");
    await sql`DROP TABLE IF EXISTS lm_text_hydro`;
    await sql`
      CREATE TABLE lm_text_hydro AS
      SELECT textstrang, geom FROM lm_text WHERE textkategori = 'Hydrografi'
             AND textstrang IS NOT NULL AND textstrang <> ''
    `;
    await sql`CREATE INDEX lm_text_hydro_geom_idx ON lm_text_hydro USING GIST (geom)`;

    // ── 3b. VISS crosswalk: which VISS lake's centroid falls inside each LM
    // polygon? Do this FIRST so we can prefer the VISS name (clean, curated)
    // over the LM centroid-label, which on big/archipelago water bodies grabs a
    // sub-feature (a bay) instead of the lake. Pick the VISS lake whose centroid
    // is nearest the LM centroid when several fall inside (largest-body wins in
    // practice since its centroid is most central).
    console.log("Crosswalking LM lakes to VISS (eu_cd + name)…");
    await sql`DROP TABLE IF EXISTS lm_cross`;
    await sql`
      CREATE TABLE lm_cross AS
      SELECT DISTINCT ON (a.id)
        a.id AS lm_id,
        viss.eu_cd        AS eu_cd,
        viss.name         AS viss_name,
        viss.municipality AS municipality,
        viss.county       AS county
      FROM lm_lake_agg a
      JOIN lakes viss
        ON viss.source = 'viss'
       AND ST_Contains(a.geom, ST_Transform(ST_SetSRID(ST_MakePoint(viss.lon, viss.lat), 4326), 3006))
      ORDER BY a.id,
               ST_Centroid(a.geom) <-> ST_Transform(ST_SetSRID(ST_MakePoint(viss.lon, viss.lat), 4326), 3006)
    `;
    await sql`CREATE INDEX lm_cross_id_idx ON lm_cross (lm_id)`;
    const [{ crossed }] = await sql<{ crossed: number }[]>`
      SELECT COUNT(*)::int crossed FROM lm_cross`;
    console.log(`  ${crossed} LM lakes matched a VISS lake.`);

    // ── 3c. Assemble each lake's fields: name = VISS name if crosswalked, else
    // the nearest Hydrografi label; municipality/county from VISS or 'Okänd'.
    console.log("Attaching names (VISS-preferred, else Hydrografi label)…");
    await sql`DROP TABLE IF EXISTS lm_lake_named`;
    await sql`
      CREATE TABLE lm_lake_named AS
      SELECT
        a.id,
        a.area_ha,
        ST_Y(a.pt_wgs84) AS lat,
        ST_X(a.pt_wgs84) AS lon,
        COALESCE(x.viss_name, nm.textstrang) AS name,
        COALESCE(x.municipality, 'Okänd')    AS municipality,
        COALESCE(x.county, 'Okänd')          AS county,
        x.eu_cd                              AS eu_cd
      FROM lm_lake_agg a
      LEFT JOIN lm_cross x ON x.lm_id = a.id
      LEFT JOIN LATERAL (
        SELECT t.textstrang
        FROM lm_text_hydro t
        WHERE ST_DWithin(t.geom, a.geom, 0)          -- name point inside the lake
        ORDER BY t.geom <-> ST_Centroid(a.geom)
        LIMIT 1
      ) nm ON true
    `;
    const [{ named }] = await sql<{ named: number }[]>`
      SELECT COUNT(*)::int named FROM lm_lake_named WHERE name IS NOT NULL`;
    console.log(`  ${named} lakes carry a name.`);

    // ── 4a. Insert ONLY the NEW lakes — those with no VISS crosswalk (eu_cd
    // NULL). A crosswalked LM lake IS the same body as its VISS row, which
    // already exists in `lakes` (carrying the curated name, kommun/län, and the
    // eu_cd that MVM/NORS join on). Inserting a second lantmateriet row for it
    // created the name-collision bug ("Tolken, Borås" resolved to 2 rows). So we
    // only add the tarns/lakes VISS never had. Their id is the LM vattenytaid
    // (a UUID) — no collision with the SE… VISS ids.
    console.log(
      `Inserting NEW (non-VISS) named lakes with area ≥ ${opts.minAreaHa} ha…`,
    );
    const inserted = await sql`
      INSERT INTO lakes (id, name, municipality, county, lat, lon, area_ha, eu_cd, source)
      SELECT id, name, municipality, county, lat, lon, area_ha, NULL, 'lantmateriet'
      FROM lm_lake_named
      WHERE name IS NOT NULL
        AND eu_cd IS NULL                         -- NEW lakes only (no VISS match)
        AND area_ha >= ${opts.minAreaHa}
        AND lat IS NOT NULL AND lon IS NOT NULL
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        municipality = excluded.municipality,
        county = excluded.county,
        lat = excluded.lat,
        lon = excluded.lon,
        area_ha = excluded.area_ha,
        source = 'lantmateriet'
      RETURNING 1
    `;
    console.log(`  inserted ${inserted.count} new Lantmäteriet-only lakes.`);

    // ── 4b. For crosswalked lakes, upgrade the existing VISS row's coords/area
    // with Lantmäteriet's more-precise polygon centroid (keep the VISS id + name
    // + eu_cd + kommun/län). One canonical row per lake — no duplicate.
    console.log("Refining crosswalked VISS lakes with LM geometry…");
    const refined = await sql`
      UPDATE lakes v
      SET lat = n.lat, lon = n.lon, area_ha = n.area_ha
      FROM lm_lake_named n
      WHERE n.eu_cd = v.eu_cd
        AND v.source = 'viss'
        AND n.eu_cd IS NOT NULL
        AND n.lat IS NOT NULL AND n.lon IS NOT NULL
      RETURNING 1
    `;
    console.log(`  refined ${refined.count} crosswalked VISS lakes.`);

    // Tidy the derived staging tables (keep lm_mark/lm_text for re-runs).
    await sql`DROP TABLE IF EXISTS lm_lake_agg, lm_lake_named, lm_text_hydro, lm_cross`;
    console.log("Transform complete.");
  } finally {
    await sql.end();
  }
}
