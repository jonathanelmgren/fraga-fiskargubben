/**
 * ETL stub: import water colour (humic/clear) and Secchi sight depth from
 * SLU Miljödata-MVM (SampleSites / FullSamples endpoints).
 *
 * Run:  pnpm etl:mvm
 *
 * ## Status
 * STUB — MVM base URL and endpoint paths are placeholders.  The script
 * validates that MVM_TICKET and DATABASE_URL are set, then exits 1 with a
 * clear error if MVM endpoints are not yet confirmed.  Replace the TODO
 * constants once the actual endpoint paths are known from the MVM API docs.
 *
 * ## Architecture (ADR-0002)
 * - The MVM ticket (MVM_TICKET env var) is used HERE, at import time only.
 * - The import-time join (station → lake) is performed by `stationMatchesLake`
 *   in `src/lib/water/station-match.ts`.
 * - The runtime path `src/lib/water/colour.ts#colourFor` is a pure table
 *   lookup — it does NOT import env.ts and never references MVM_TICKET.
 *
 * ## Idempotency
 * Upserts on lake_id PK (ON CONFLICT DO UPDATE).  Re-runs are safe.
 *
 * ## Colour classification
 * `deriveColour` in `src/lib/water/colour.ts`:
 *   - absorbans420 > 0.1 m⁻¹ → 'brown'; ≤ 0.1 → 'clear'
 *   - fargtal > 30 mg Pt/L  → 'brown'; ≤ 30  → 'clear'
 * Threshold references: EEA humic classification and Naturvårdsverket
 * water colour guidelines for Swedish national lake monitoring.
 */

// ---------------------------------------------------------------------------
// MVM endpoint placeholders
// Verify actual paths against https://miljodata.slu.se/mvm/api/
// ---------------------------------------------------------------------------
const MVM_BASE_URL =
  process.env.MVM_BASE_URL ??
  "<TODO: MVM base URL — e.g. https://miljodata.slu.se/mvm/api/v1>";

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

/**
 * L: redact the MVM_TICKET secret before logging a URL. The ticket stays in the
 * request itself (the un-redacted URL is what we fetch) — only the log output is
 * sanitised so the secret never lands in CI logs / terminal scrollback.
 */
function redactTicket(url: string): string {
  return url.replace(/ticket=[^&]*/i, "ticket=***");
}

// ---------------------------------------------------------------------------
// Type definitions (shapes are placeholder — adapt to real MVM response)
// ---------------------------------------------------------------------------

/** A sample station from the MVM SampleSites endpoint. */
export interface MvmStation {
  /** MVM station identifier. */
  stationId: string;
  /** Station name. */
  name?: string;
  /** Latitude (WGS84). */
  lat: number;
  /** Longitude (WGS84). */
  lon: number;
}

/** One measurement record from the MVM FullSamples endpoint. */
export interface MvmSample {
  /** Station identifier — links back to MvmStation.stationId. */
  stationId: string;
  /**
   * Absorbance at 420 nm (A₄₂₀, m⁻¹).
   * Used by deriveColour; preferred over fargtal when present.
   */
  absorbans420?: number | null;
  /**
   * Swedish Pt water colour number (mg Pt/L, "färgtal").
   * Fallback when absorbans420 is absent.
   */
  fargtal?: number | null;
  /** Secchi sight depth in metres. */
  siktdjupM?: number | null;
}

/** Row shape matching the `water_colour` Drizzle table. */
export interface ColourRow {
  lakeId: string;
  colour: "brown" | "clear";
  sightDepthM: number | null;
  confidence: "high" | "low";
}

// ---------------------------------------------------------------------------
// Pure mapper — unit-testable without DB or network
// ---------------------------------------------------------------------------

/**
 * Map one MVM sample + its matched lake id / confidence to a water_colour row.
 *
 * Throws if neither colour indicator is present or the lakeId is empty.
 */
export function mapMvmSample(
  sample: MvmSample,
  lakeId: string,
  confidence: "high" | "low",
): ColourRow {
  if (!lakeId) {
    throw new Error("mapMvmSample: lakeId must not be empty.");
  }

  // Lazy-require deriveColour to keep this file testable without heavy deps.
  const absorbans420 =
    sample.absorbans420 !== null ? sample.absorbans420 : undefined;
  const fargtal = sample.fargtal !== null ? sample.fargtal : undefined;

  if (absorbans420 === undefined && fargtal === undefined) {
    throw new Error(
      `mapMvmSample: sample for station ${sample.stationId} has neither absorbans420 nor fargtal.`,
    );
  }

  const colour: "brown" | "clear" =
    absorbans420 !== undefined
      ? absorbans420 > 0.1
        ? "brown"
        : "clear"
      : (fargtal as number) > 30
        ? "brown"
        : "clear";

  const sightDepthM =
    sample.siktdjupM !== undefined && sample.siktdjupM !== null
      ? Number.isFinite(sample.siktdjupM)
        ? sample.siktdjupM
        : null
      : null;

  return { lakeId, colour, sightDepthM, confidence };
}

// ---------------------------------------------------------------------------
// Script body — runs only when executed directly (not when imported by tests)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (MVM_BASE_URL.startsWith("<TODO")) {
    console.error(
      "ERROR: MVM_BASE_URL is not configured.\n" +
        "Set the MVM_BASE_URL environment variable to the SLU Miljödata-MVM\n" +
        "API base URL (see scripts/etl/README.md — MVM section).\n",
    );
    process.exit(1);
  }

  const ticket = process.env.MVM_TICKET;
  if (!ticket) {
    console.error(
      "ERROR: MVM_TICKET is not set.\n" +
        "Register at Artdatabanken UserAdmin and activate the ticket in\n" +
        "Miljödata-MVM 'Mina sidor'.  See .env.example for details.\n",
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
  const { waterColour, lakes } = await import("@/shared/db/schema");
  const { stationMatchesLake } = await import("@/lib/water/station-match");
  const { deriveColour } = await import("@/lib/water/colour");
  const { haversine } = await import("@/lib/geo/haversine");

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

  // ── 2. Fetch MVM sample stations ─────────────────────────────────────────
  const stationsUrl = `${MVM_BASE_URL}/SampleSites?ticket=${ticket}`;
  console.log(`Fetching MVM sample sites from: ${redactTicket(stationsUrl)}`);

  const stationsRes = await fetch(stationsUrl);
  if (!stationsRes.ok) {
    throw new Error(
      `Failed to fetch MVM stations: ${stationsRes.status} ${stationsRes.statusText}`,
    );
  }
  const stations: MvmStation[] = (await stationsRes.json()) as MvmStation[];
  console.log(`Fetched ${stations.length} MVM stations.`);

  // ── 3. Fetch MVM measurements (FullSamples) ───────────────────────────────
  const samplesUrl = `${MVM_BASE_URL}/FullSamples?ticket=${ticket}`;
  console.log(`Fetching MVM samples from: ${redactTicket(samplesUrl)}`);

  const samplesRes = await fetch(samplesUrl);
  if (!samplesRes.ok) {
    throw new Error(
      `Failed to fetch MVM samples: ${samplesRes.status} ${samplesRes.statusText}`,
    );
  }
  const samples: MvmSample[] = (await samplesRes.json()) as MvmSample[];
  console.log(`Fetched ${samples.length} MVM samples.`);

  // ── 4. Index stations by id ───────────────────────────────────────────────
  const stationMap = new Map<string, MvmStation>(
    stations.map((s) => [s.stationId, s]),
  );

  // ── 5. Join station → lake at import time (ADR-0002) ─────────────────────
  const rows: ColourRow[] = [];
  let skipped = 0;
  let noMatch = 0;

  // Best sample per lake: prefer high confidence and more-recent data.
  // For this stub we keep the last-seen row per lakeId (operator can refine).
  const bestByLake = new Map<string, ColourRow>();

  // C2: memoize the station→lake match per UNIQUE stationId.  The previous
  // code re-ran the full O(lakes) scan + haversine for EVERY sample row, so a
  // station with N time-series samples was re-joined N times → effectively
  // O(samples × lakes).  Memoizing collapses it to O(stations × lakes).  A
  // coarse bounding-box pre-filter (BBOX_DEG) skips far-away lakes before the
  // haversine so each station→lake join is near-O(local lakes).
  // [scope] memo + bbox pre-filter only; a full PostGIS spatial index is
  // deferred.  [~] deferred: PostGIS spatial join.
  type StationMatch = { lakeId: string; confidence: "high" | "low" } | null;
  const matchByStation = new Map<string, StationMatch>();

  /** ~degrees of latitude per km; lakes farther than the area radius can't match. */
  const BBOX_DEG = 0.6; // ~66 km half-window — generous vs largest area radii

  function joinStationToLake(station: MvmStation): StationMatch {
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

      // Haversine for tie-breaking — prefer closest lake.
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

  for (const sample of samples) {
    const station = stationMap.get(sample.stationId);
    if (!station) {
      skipped++;
      continue;
    }

    const matched = joinStationToLake(station);
    if (matched === null) {
      noMatch++;
      continue;
    }
    const bestLakeId = matched.lakeId;
    const bestConfidence = matched.confidence;

    let row: ColourRow;
    try {
      const absorbans420 =
        sample.absorbans420 !== null && sample.absorbans420 !== undefined
          ? sample.absorbans420
          : undefined;
      const fargtal =
        sample.fargtal !== null && sample.fargtal !== undefined
          ? sample.fargtal
          : undefined;

      const colour = deriveColour({ absorbans420, fargtal });
      const sightDepthM =
        sample.siktdjupM !== undefined &&
        sample.siktdjupM !== null &&
        Number.isFinite(sample.siktdjupM)
          ? sample.siktdjupM
          : null;

      row = {
        lakeId: bestLakeId,
        colour,
        sightDepthM,
        confidence: bestConfidence,
      };
    } catch (err) {
      skipped++;
      console.warn(
        `Skipping sample for station ${sample.stationId}: ${(err as Error).message}`,
      );
      continue;
    }

    // Keep high-confidence over low; otherwise last-seen wins.
    const existing = bestByLake.get(bestLakeId);
    if (
      !existing ||
      (row.confidence === "high" && existing.confidence === "low")
    ) {
      bestByLake.set(bestLakeId, row);
    }
  }

  rows.push(...bestByLake.values());

  // ── 6. Batch upsert (chunked) ──────────────────────────────────────────────
  // H8: chunk the insert.  Postgres caps a statement at 65,535 bind params, so
  // a single INSERT of up to ~100k rows × 4 cols would throw at ~16k rows.
  // BATCH_SIZE keeps each statement well under the cap.
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(waterColour)
      .values(chunk)
      .onConflictDoUpdate({
        target: waterColour.lakeId,
        set: {
          colour: sql`excluded.colour`,
          sightDepthM: sql`excluded.sight_depth_m`,
          confidence: sql`excluded.confidence`,
        },
      });
  }

  console.log(
    `\nDone. Imported: ${rows.length}, No match: ${noMatch}, Skipped (errors): ${skipped}`,
  );

  await pg.end();
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("import-mvm.ts") ||
    process.argv[1].endsWith("import-mvm.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
