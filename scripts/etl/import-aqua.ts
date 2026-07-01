/**
 * ETL stub: import fish species per lake from SLU Aqua / Sötebasen
 * (test-fishing / provfiske) data.
 *
 * Run:  pnpm etl:aqua
 *
 * ## Status
 * STUB — the SLU Aqua / Sötebasen API base URL and endpoint paths are
 * placeholders.  The script validates that AQUA_BASE_URL and DATABASE_URL are
 * set, then exits 1 with a clear error if endpoints have not been confirmed.
 * Replace the TODO constants once the actual endpoint paths are known.
 *
 * ## No ticket / authentication required (per spec §6)
 * SLU Aqua / Sötebasen provfiske data is publicly available.  If the real
 * endpoint does require authentication, add an AQUA_TOKEN env var here and
 * document it in the README.
 *
 * ## Architecture (ADR-0002)
 * - The import-time join (station → lake) is performed by `stationMatchesLake`
 *   in `src/lib/water/station-match.ts`.  All external calls happen HERE; the
 *   runtime path `src/lib/water/species.ts#speciesFor` is a pure table lookup.
 * - Species per lake are collected from all survey records that matched, then
 *   deduplicated and normalized via `normalizeSpecies` from `species.ts`.
 *
 * ## Idempotency
 * Upserts on lake_id PK (ON CONFLICT DO UPDATE).  Re-runs are safe.
 */

// ---------------------------------------------------------------------------
// Aqua / Sötebasen endpoint placeholders
// Verify actual paths against https://www.slu.se/aqua/ and Sötebasen docs.
// ---------------------------------------------------------------------------
const AQUA_BASE_URL =
  process.env.AQUA_BASE_URL ??
  "<TODO: Aqua base URL — e.g. https://sotebasen.slu.se/api/v1>";

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Type definitions (shapes are placeholders — adapt to real Sötebasen response)
// ---------------------------------------------------------------------------

/** A survey station from the Sötebasen stations endpoint. */
export interface AquaStation {
  /** Station / survey site identifier. */
  stationId: string;
  /** Station name. */
  name?: string;
  /** Latitude (WGS84). */
  lat: number;
  /** Longitude (WGS84). */
  lon: number;
}

/** One survey catch record from the Sötebasen catches endpoint. */
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
        "Set the AQUA_BASE_URL environment variable to the SLU Aqua /\n" +
        "Sötebasen API base URL.  See scripts/etl/README.md — Aqua section.\n",
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

  // ── 2. Fetch survey stations ──────────────────────────────────────────────
  const stationsUrl = `${AQUA_BASE_URL}/stations`;
  console.log(`Fetching Aqua survey stations from: ${stationsUrl}`);

  const stationsRes = await fetch(stationsUrl);
  if (!stationsRes.ok) {
    throw new Error(
      `Failed to fetch Aqua stations: ${stationsRes.status} ${stationsRes.statusText}`,
    );
  }
  const stations: AquaStation[] = (await stationsRes.json()) as AquaStation[];
  console.log(`Fetched ${stations.length} Aqua stations.`);

  // ── 3. Fetch catch records ────────────────────────────────────────────────
  const catchesUrl = `${AQUA_BASE_URL}/catches`;
  console.log(`Fetching Aqua catch records from: ${catchesUrl}`);

  const catchesRes = await fetch(catchesUrl);
  if (!catchesRes.ok) {
    throw new Error(
      `Failed to fetch Aqua catches: ${catchesRes.status} ${catchesRes.statusText}`,
    );
  }
  const catches: AquaCatch[] = (await catchesRes.json()) as AquaCatch[];
  console.log(`Fetched ${catches.length} Aqua catch records.`);

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

  for (const [stationId, station] of stationMap) {
    const rawSpeciesForStation = catchesByStation.get(stationId);
    if (!rawSpeciesForStation || rawSpeciesForStation.length === 0) {
      continue;
    }

    // Find the best-matching lake for this station.
    let bestLakeId: string | null = null;
    let bestConfidence: "high" | "low" | null = null;
    let bestDistKm = Number.POSITIVE_INFINITY;

    for (const lake of lakeCandidates) {
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

    if (bestLakeId === null || bestConfidence === null) {
      noMatch++;
      continue;
    }

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
