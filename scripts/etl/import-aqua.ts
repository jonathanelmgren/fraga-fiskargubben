/**
 * ETL: import fish species per lake from SLU Aqua's NORS database
 * (Nationellt Register över Sjöprovfisken — lake test-fishing / provfiske).
 *
 * Run:  pnpm etl:aqua
 *
 * ## Source — VERIFIED live 2026-07-01
 * SLU Aqua publishes NORS via the public data portal at https://dvfisk.slu.se.
 * The Angular app calls a REST API under `api/v1/nors`; the per-lake aggregated
 * report endpoint is:
 *   GET https://dvfisk.slu.se/api/v1/nors/data-aggregerad/rapport
 * Live-checked: returns a flat JSON array (~4250 lakes) of one record per lake.
 * Field description: https://dvfisk.slu.se/assets/NORS_databeskrivning.pdf
 * (section "Nätprovfiske aggregerade data").  Relevant fields (camelCased in
 * the JSON response):
 *   eU_CD        — EU WFD water-body code (matches `lakes.id`; blank " " for
 *                  ~6% of rows that predate WFD delineation)
 *   sjö          — lake name with SMHI id prefix, e.g. "624588-149908 Malmsjön"
 *   fångadeArter — comma-separated species list, e.g. "Abborre,Gädda,Mört"
 *   sweref99N/E  — SWEREF99TM coordinates (metres) — NOT WGS84
 *   area         — area in hectares;  maxDjup — max depth (m);  höH — elevation
 *
 * No authentication ticket is required (public data, spec §6).
 *
 * ## Architecture (ADR-0002)
 * - All external calls happen HERE; the runtime path
 *   `src/lib/water/species.ts#speciesFor` is a pure table lookup.
 * - Species per lake are collected from all matching survey records, then
 *   deduplicated and normalized via `normalizeSpecies` from `species.ts`.
 *
 * ## Station→lake join (issue #4)
 * The NORS aggregated record already carries `eU_CD` (the lake PK) DIRECTLY, so
 * the ~94% of rows with an eU_CD join straight on `lakes.id` (O(1), high
 * confidence, no haversine).  Only blank-eU_CD rows fall back to the
 * `stationMatchesLake` centroid match, which is now bounding-box pre-filtered
 * and memoized per station (see `joinStationToLake` in §6) so it is
 * O(fallback-rows × local-lakes) rather than O(rows × lakes).
 * TODO: blank-eU_CD coordinates are still SWEREF99TM metres, not WGS84 — the
 * fallback only matches once those are reprojected (see below).
 *
 * ## Idempotency
 * Upserts on lake_id PK (ON CONFLICT DO UPDATE).  Re-runs are safe.
 */

// ---------------------------------------------------------------------------
// NORS aggregated-report endpoint — VERIFIED live 2026-07-01.
// Base is the dvfisk portal; the aggregated per-lake report path is fixed.
// ---------------------------------------------------------------------------
const AQUA_BASE_URL =
  process.env.AQUA_BASE_URL ?? "https://dvfisk.slu.se/api/v1/nors";

/** Per-lake aggregated NORS report (one record per surveyed lake). */
const AQUA_RAPPORT_PATH =
  process.env.AQUA_RAPPORT_PATH ?? "/data-aggregerad/rapport";

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions — VERIFIED against the live NORS aggregated response.
// ---------------------------------------------------------------------------

/**
 * One record from the NORS aggregated report
 * (GET /data-aggregerad/rapport).  Keys are camelCased by the API from the
 * Swedish column names documented in NORS_databeskrivning.pdf.  Only the
 * fields this ETL consumes are typed; the record carries ~40 more.
 */
export interface NorsAggregatedRecord {
  /** EU WFD water-body code (matches `lakes.id`); " " (blank) for some rows. */
  eU_CD?: string | null;
  /** Lake name with SMHI id prefix, e.g. "624588-149908 Malmsjön". */
  sjö?: string | null;
  /** Comma-separated species list, e.g. "Abborre,Gädda,Mört,Sarv". */
  fångadeArter?: string | null;
  /** SWEREF99TM northing (metres) — NOT WGS84 latitude. */
  sweref99N?: number | null;
  /** SWEREF99TM easting (metres) — NOT WGS84 longitude. */
  sweref99E?: number | null;
  /** Lake area in hectares. */
  area?: number | null;
}

/**
 * A survey station as consumed by the (unchanged) join loop below.  Populated
 * by adapting a NorsAggregatedRecord.  `euCd` is carried through so issue #4
 * can join directly on it; `lat`/`lon` are the raw SWEREF99 coordinates and
 * MUST be reprojected to WGS84 before the haversine join is meaningful (TODO).
 */
export interface AquaStation {
  /** Station identifier — the NORS eU_CD (or a synthesized key when blank). */
  stationId: string;
  /** EU WFD water-body code, when present (issue #4 joins directly on this). */
  euCd?: string;
  /** Lake name. */
  name?: string;
  /** SWEREF99TM northing (metres) — reproject to WGS84 lat before use. */
  lat: number;
  /** SWEREF99TM easting (metres) — reproject to WGS84 lon before use. */
  lon: number;
}

/** One species observed at a station (expanded from `fångadeArter`). */
export interface AquaCatch {
  /** Station identifier — links back to AquaStation.stationId. */
  stationId: string;
  /** Swedish common name of the caught species (e.g. "Abborre", "Gädda"). */
  species: string;
}

/** Row shape matching the `lake_species` Drizzle table. */
export interface SpeciesRow {
  lakeId: string;
  species: string[];
  confidence: "high" | "low";
}

// ---------------------------------------------------------------------------
// Script body — runs only when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (AQUA_BASE_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: AQUA_BASE_URL is not configured.\n" +
        "Set the AQUA_BASE_URL environment variable to the SLU Aqua NORS\n" +
        "API base URL.  See scripts/etl/README.md — Aqua section.\n",
    );
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  // Lazy imports — DB / server-only code never loaded by pure tests.
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { sql } = await import("drizzle-orm");
  const { lakeSpecies, lakes } = await import("@/shared/db/schema");
  const { stationMatchesLake } = await import("@/lib/water/station-match");
  const { haversine } = await import("@/lib/geo/haversine");
  const { normalizeSpecies } = await import("@/lib/water/species");

  const pg = postgres(databaseUrl);
  const db = drizzle(pg);

  // ── 1. Fetch all lake candidates from the DB ──────────────────────────────
  const lakeCandidates = await db
    .select({
      id: lakes.id,
      lat: lakes.lat,
      lon: lakes.lon,
      areaHa: lakes.areaHa,
    })
    .from(lakes);

  console.log(`Loaded ${lakeCandidates.length} lakes from DB.`);

  // ── 2. Fetch the NORS aggregated per-lake report (single endpoint) ─────────
  const rapportUrl = `${AQUA_BASE_URL}${AQUA_RAPPORT_PATH}`;
  console.log(`Fetching NORS aggregated report from: ${rapportUrl}`);

  const rapportRes = await fetch(rapportUrl);
  if (!rapportRes.ok) {
    throw new Error(
      `Failed to fetch NORS report: ${rapportRes.status} ${rapportRes.statusText}`,
    );
  }
  const records: NorsAggregatedRecord[] =
    (await rapportRes.json()) as NorsAggregatedRecord[];
  console.log(`Fetched ${records.length} NORS aggregated records.`);

  // ── 3. Adapt the aggregated records into the station + catch shapes the ────
  //       (unchanged, issue-#4-owned) join loop below consumes.  One aggregated
  //       record = one station; `fångadeArter` expands to one AquaCatch per
  //       species.  The eU_CD is carried on the station so #4 can join directly.
  const stations: AquaStation[] = [];
  const catches: AquaCatch[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const euCd = (r.eU_CD ?? "").trim();
    // A stable per-record station id: prefer eU_CD, else fall back to the row
    // index so blank-eU_CD rows still get a unique key for the coordinate join.
    const stationId = euCd || `nors-row-${i}`;
    const lat = r.sweref99N;
    const lon = r.sweref99E;
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    stations.push({
      stationId,
      euCd: euCd || undefined,
      name: r.sjö ?? undefined,
      lat,
      lon,
    });

    for (const species of (r.fångadeArter ?? "").split(",")) {
      const trimmed = species.trim();
      if (trimmed) catches.push({ stationId, species: trimmed });
    }
  }
  console.log(
    `Adapted ${stations.length} stations and ${catches.length} catch rows.`,
  );

  // ── 4. Index stations by id ───────────────────────────────────────────────
  const stationMap = new Map<string, AquaStation>(
    stations.map((s) => [s.stationId, s]),
  );

  // ── 5. Index catches by stationId ─────────────────────────────────────────
  const catchesByStation = new Map<string, string[]>();
  for (const c of catches) {
    const list = catchesByStation.get(c.stationId);
    if (list) {
      list.push(c.species);
    } else {
      catchesByStation.set(c.stationId, [c.species]);
    }
  }

  // ── 6. Join station → lake at import time (ADR-0002) ─────────────────────
  // Accumulate species per lake across all matching stations.
  const speciesByLake = new Map<
    string,
    { rawSpecies: string[]; confidence: "high" | "low" }
  >();
  let skipped = 0;
  let noMatch = 0;

  // #4: two-tier join.
  //   (a) DIRECT — most NORS rows carry `eU_CD` (the lake PK), so join straight
  //       on `lakes.id` in O(1) with no haversine.  This is the ~94% path.
  //   (b) COORDINATE FALLBACK — only blank-eU_CD rows fall through to the
  //       centroid join, now with a bounding-box pre-filter + per-station memo
  //       (mirrors import-mvm.ts) so it is O(fallback-stations × local-lakes)
  //       instead of O(stations × lakes).  [~] deferred: PostGIS spatial join.
  const lakeById = new Map(lakeCandidates.map((lake) => [lake.id, lake]));

  /** ~degrees of latitude per km; lakes farther than the area radius can't match. */
  const BBOX_DEG = 0.6; // ~66 km half-window — generous vs largest area radii

  type StationMatch = { lakeId: string; confidence: "high" | "low" } | null;
  const matchByStation = new Map<string, StationMatch>();

  function joinStationToLake(station: AquaStation): StationMatch {
    // (a) Direct eU_CD join — no coordinate math when the lake PK is present.
    if (station.euCd) {
      const lake = lakeById.get(station.euCd);
      if (lake) return { lakeId: lake.id, confidence: "high" };
      // eU_CD present but not in our lakes table → fall through to coordinates.
    }

    // (b) Coordinate fallback, memoized per unique station id.
    const cached = matchByStation.get(station.stationId);
    if (cached !== undefined) return cached;

    let bestLakeId: string | null = null;
    let bestConfidence: "high" | "low" | null = null;
    let bestDistKm = Number.POSITIVE_INFINITY;

    for (const lake of lakeCandidates) {
      // Cheap bounding-box reject before the trig-heavy haversine.
      if (
        Math.abs(lake.lat - station.lat) > BBOX_DEG ||
        Math.abs(lake.lon - station.lon) > BBOX_DEG
      ) {
        continue;
      }

      const match = stationMatchesLake(
        { lat: station.lat, lon: station.lon },
        { lat: lake.lat, lon: lake.lon, areaHa: lake.areaHa },
      );
      if (!match.matches) continue;
      const { confidence } = match;

      const distKm = haversine(
        { lat: station.lat, lon: station.lon },
        { lat: lake.lat, lon: lake.lon },
      );

      const isBetter =
        bestLakeId === null ||
        (confidence === "high" && bestConfidence === "low") ||
        (confidence === bestConfidence && distKm < bestDistKm);

      if (isBetter) {
        bestLakeId = lake.id;
        bestConfidence = confidence;
        bestDistKm = distKm;
      }
    }

    const result: StationMatch =
      bestLakeId !== null && bestConfidence !== null
        ? { lakeId: bestLakeId, confidence: bestConfidence }
        : null;
    matchByStation.set(station.stationId, result);
    return result;
  }

  for (const [stationId, station] of stationMap) {
    const rawSpeciesForStation = catchesByStation.get(stationId);
    if (!rawSpeciesForStation || rawSpeciesForStation.length === 0) {
      continue;
    }

    const joined = joinStationToLake(station);
    if (joined === null) {
      noMatch++;
      continue;
    }
    const { lakeId: bestLakeId, confidence: bestConfidence } = joined;

    // Accumulate species for this lake; prefer high confidence.
    const existing = speciesByLake.get(bestLakeId);
    if (!existing) {
      speciesByLake.set(bestLakeId, {
        rawSpecies: [...rawSpeciesForStation],
        confidence: bestConfidence,
      });
    } else {
      // Merge species lists; upgrade confidence if station is higher quality.
      existing.rawSpecies.push(...rawSpeciesForStation);
      if (bestConfidence === "high" && existing.confidence === "low") {
        existing.confidence = "high";
      }
    }
  }

  // ── 7. Build final rows (normalize + deduplicate species) ─────────────────
  const rows: SpeciesRow[] = [];
  for (const [lakeId, { rawSpecies, confidence }] of speciesByLake) {
    const species = normalizeSpecies(rawSpecies);
    if (species.length === 0) {
      skipped++;
      continue;
    }
    rows.push({ lakeId, species, confidence });
  }

  // ── 8. Batch upsert (chunked) ──────────────────────────────────────────────
  // H8: chunk so a large INSERT can't exceed Postgres' 65,535 bind-param cap.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(lakeSpecies)
      .values(chunk)
      .onConflictDoUpdate({
        target: lakeSpecies.lakeId,
        set: {
          species: sql`excluded.species`,
          confidence: sql`excluded.confidence`,
        },
      });
  }

  console.log(
    `\nDone. Imported: ${rows.length}, No match: ${noMatch}, Skipped (no species): ${skipped}`,
  );

  await pg.end();
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("import-aqua.ts") ||
    process.argv[1].endsWith("import-aqua.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
