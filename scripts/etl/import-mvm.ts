/**
 * ETL: import water colour (humic/clear) and Secchi sight depth from
 * SLU Miljödata-MVM (Observations API v2).
 *
 * Run:  pnpm etl:mvm
 *
 * ## Source — endpoints VERIFIED against the OpenAPI spec 2026-07-01
 * MVM exposes a REST v2 API documented at
 *   https://miljodata.slu.se/api/docs/index.html
 *   (spec: https://miljodata.slu.se/api/docs/mvm-api-v2/swagger.json)
 * Base path: https://miljodata.slu.se/api/observations-service/v2
 * The public ticket is passed as the query parameter `token` (NOT `ticket`).
 * Relevant endpoints (all GET):
 *   /sample-sites/ids        → list sample-site ids (filterable)
 *   /sample-sites/{id}        → one SampleSite (coordinates + CRS)
 *   /full-samples/query       → samples WITH observations (filterable)
 *   /full-samples/{id}        → one Sample with observations
 *   /all-full-samples/chemistry → pre-generated chemistry export (bulk)
 *
 * ## FLAG — structurally wired, live-verification pending (needs MVM_TICKET)
 * Two structural facts differ from the previous stub and could NOT be confirmed
 * live without a ticket; they are the main work remaining before a real run:
 *
 * 1. Coordinates are SWEREF99TM, not WGS84.  SampleSite carries
 *    `sampleSiteCoordinateN/E` (or `X/Y`) plus `sampleSiteCoordinateSystem`.
 *    They MUST be reprojected to WGS84 before the haversine/stationMatchesLake
 *    join is meaningful.  (SWEREF99→WGS84 projection is still TODO — see below.)
 *
 * 2. Chemistry values are NESTED, not flat.  A Sample has an `observations[]`
 *    array of SampleObservation, each identified by a `propertyCode`/
 *    `propertyAbbrevName`, whose `observationValues[]` hold the `value`+`unit`.
 *    Absorbance-420 / färgtal / Secchi are therefore looked up BY PROPERTY CODE,
 *    not as top-level `absorbans420`/`fargtal`/`siktdjupM` keys.  The exact
 *    property codes must be read from GET /common (or a sample response) with a
 *    live ticket and wired into extractMvmSample() below.
 *    Verify command (needs a ticket):
 *      curl "https://miljodata.slu.se/api/observations-service/v2/full-samples/query?token=$MVM_TICKET" | jq '.[0].observations[].propertyAbbrevName'
 *
 * ## Architecture (ADR-0002)
 * - The MVM ticket (MVM_TICKET env var) is used HERE, at import time only.
 * - The import-time join (station → lake) is performed by `stationMatchesLake`
 *   in `src/lib/water/station-match.ts`.
 * - The runtime path `src/lib/water/colour.ts#colourFor` is a pure table
 *   lookup — it does NOT import env.ts and never references MVM_TICKET.
 *
 * ## FLAG for issue #4 (station→lake join restructure)
 * The join loop below is left as-is for #4.  The MVM Sample/SampleSite also
 * expose `stationEUID` / `sampleSiteEUId` — if those carry the EU WFD code, #4
 * can join directly on `lakes.id` instead of the coordinate match.
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
// MVM Observations API v2 — base path VERIFIED against the OpenAPI spec.
// The ticket is a query parameter named `token`.
// ---------------------------------------------------------------------------
const MVM_BASE_URL =
  process.env.MVM_BASE_URL ??
  "https://miljodata.slu.se/api/observations-service/v2";

/** H8: chunk size keeps each INSERT well under Postgres' 65,535 bind-param cap. */
const BATCH_SIZE = 1_000;

/**
 * L: redact the MVM secret before logging a URL. The secret stays in the
 * request itself (the un-redacted URL is what we fetch) — only the log output is
 * sanitised so the secret never lands in CI logs / terminal scrollback.
 * The v2 API passes the secret as `token=`; older paths used `ticket=` — redact
 * both so a value can never leak regardless of which query key is in use.
 */
function redactTicket(url: string): string {
  return url.replace(/(ticket|token)=[^&]*/gi, "$1=***");
}

// ---------------------------------------------------------------------------
// Type definitions — raw MVM v2 shapes VERIFIED against the OpenAPI schema;
// MvmStation/MvmSample are the flattened shapes the join loop consumes.
// ---------------------------------------------------------------------------

/** A sample station consumed by the join loop (from a raw MvmRawSampleSite). */
export interface MvmStation {
  /** MVM sample-site identifier (SampleSite.sampleSiteId, stringified). */
  stationId: string;
  /** Station name (SampleSite.preferredName). */
  name?: string;
  /**
   * Latitude — MUST be WGS84 for the join.  MVM returns SWEREF99TM in
   * `sampleSiteCoordinateN`; the fetch code is responsible for reprojection
   * (still TODO — see the module FLAG).
   */
  lat: number;
  /** Longitude — WGS84 (reprojected from `sampleSiteCoordinateE`). */
  lon: number;
}

/**
 * Raw MVM v2 SampleSite (subset of fields this ETL reads).  VERIFIED against
 * the OpenAPI schema 2026-07-01.  Coordinates carry an explicit CRS.
 */
export interface MvmRawSampleSite {
  sampleSiteId?: number;
  preferredName?: string | null;
  /** EU WFD id, if populated (issue #4 could join directly on this). */
  sampleSiteEUId?: string | null;
  /** SWEREF99TM northing / easting. */
  sampleSiteCoordinateN?: number | null;
  sampleSiteCoordinateE?: number | null;
  /** Coordinate reference system name, e.g. "SWEREF99TM". */
  sampleSiteCoordinateSystem?: string | null;
}

/** One value inside a SampleObservation (VERIFIED — SampleObservationValue). */
export interface MvmRawObservationValue {
  value?: string | null;
  unit?: string | null;
}

/** One observed property on a sample (VERIFIED — SampleObservation). */
export interface MvmRawObservation {
  /** Machine property code (used to identify absorbance / färgtal / Secchi). */
  propertyCode?: string | null;
  /** Abbreviated property name, e.g. "Abs_F 420". */
  propertyAbbrevName?: string | null;
  propertyName?: string | null;
  observationValues?: MvmRawObservationValue[] | null;
}

/** Raw MVM v2 Sample (subset) — carries nested observations (VERIFIED). */
export interface MvmRawSample {
  sampleId?: number;
  samplingSiteId?: number;
  observations?: MvmRawObservation[] | null;
}

/**
 * Flattened measurement extracted from a raw MvmRawSample by extractMvmSample()
 * — the shape the (unchanged) join loop and mapMvmSample consume.  The three
 * value fields are pulled out of the nested `observations[]` by property code.
 */
export interface MvmSample {
  /** Sample-site identifier — links back to MvmStation.stationId. */
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
// Raw-response adapters — bridge the real MVM v2 shapes to the flat shapes the
// (issue-#4-owned) join loop consumes.
// ---------------------------------------------------------------------------

/**
 * MVM property codes for the fields we read.  FLAG: these are the documented
 * abbreviations but the exact `propertyCode`/`propertyAbbrevName` strings MUST
 * be confirmed against a live response (needs MVM_TICKET) — see the module FLAG.
 * Matching is done case-insensitively against both propertyCode and
 * propertyAbbrevName so either identifier works.
 */
const MVM_PROPERTY_MATCH = {
  /** Absorbance, filtered, 420 nm (A₄₂₀). */
  absorbans420: ["abs_f 420", "abs_f420", "absorbans_420", "abs420"],
  /** Färgtal (Pt colour number). */
  fargtal: ["färg", "fargtal", "färgtal", "colour"],
  /** Siktdjup (Secchi sight depth). */
  siktdjup: ["siktdjup", "secchi"],
} as const;

function matchesProperty(obs: MvmRawObservation, needles: readonly string[]) {
  const hay =
    `${obs.propertyCode ?? ""} ${obs.propertyAbbrevName ?? ""} ${obs.propertyName ?? ""}`.toLowerCase();
  return needles.some((n) => hay.includes(n));
}

function firstNumericValue(obs: MvmRawObservation): number | undefined {
  for (const v of obs.observationValues ?? []) {
    const num = Number.parseFloat((v.value ?? "").replace(",", "."));
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

/**
 * Flatten one raw MVM Sample into the MvmSample the join loop consumes, pulling
 * absorbance / färgtal / Secchi out of the nested `observations[]` by property.
 * FLAG: verify MVM_PROPERTY_MATCH against a live response before a real run.
 */
export function extractMvmSample(raw: MvmRawSample): MvmSample {
  const out: MvmSample = {
    stationId: String(raw.samplingSiteId ?? ""),
  };
  for (const obs of raw.observations ?? []) {
    if (matchesProperty(obs, MVM_PROPERTY_MATCH.absorbans420)) {
      out.absorbans420 = firstNumericValue(obs) ?? out.absorbans420;
    } else if (matchesProperty(obs, MVM_PROPERTY_MATCH.fargtal)) {
      out.fargtal = firstNumericValue(obs) ?? out.fargtal;
    } else if (matchesProperty(obs, MVM_PROPERTY_MATCH.siktdjup)) {
      out.siktdjupM = firstNumericValue(obs) ?? out.siktdjupM;
    }
  }
  return out;
}

/**
 * Convert a raw MVM SampleSite to the join-loop MvmStation.
 * FLAG: MVM returns SWEREF99TM (`sampleSiteCoordinateN/E`).  Reprojection to
 * WGS84 is still TODO — for now the raw SWEREF99 metres are passed through and
 * the coordinate join will NOT be meaningful until a projection is added (or
 * issue #4 switches to an EU-id join via `sampleSiteEUId`).
 */
export function adaptMvmStation(raw: MvmRawSampleSite): MvmStation | null {
  const lat = raw.sampleSiteCoordinateN;
  const lon = raw.sampleSiteCoordinateE;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return {
    stationId: String(raw.sampleSiteId ?? ""),
    name: raw.preferredName ?? undefined,
    lat, // TODO(#4): reproject SWEREF99TM → WGS84
    lon,
  };
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

  // ── 2. Fetch MVM sample sites ────────────────────────────────────────────
  // FLAG: /sample-sites/ids returns ids only; a full site list may require
  // iterating /sample-sites/{id}.  Wired against the documented query shape;
  // confirm the exact response envelope with a live ticket (see module FLAG).
  const stationsUrl = `${MVM_BASE_URL}/sample-sites/ids?token=${encodeURIComponent(ticket)}`;
  console.log(`Fetching MVM sample sites from: ${redactTicket(stationsUrl)}`);

  const stationsRes = await fetch(stationsUrl);
  if (!stationsRes.ok) {
    throw new Error(
      `Failed to fetch MVM stations: ${stationsRes.status} ${stationsRes.statusText}`,
    );
  }
  const rawSites = (await stationsRes.json()) as MvmRawSampleSite[];
  const stations: MvmStation[] = rawSites.flatMap((s) => {
    const adapted = adaptMvmStation(s);
    return adapted ? [adapted] : [];
  });
  console.log(`Fetched ${stations.length} MVM stations.`);

  // ── 3. Fetch MVM measurements (full samples with nested observations) ─────
  const samplesUrl = `${MVM_BASE_URL}/full-samples/query?token=${encodeURIComponent(ticket)}`;
  console.log(`Fetching MVM samples from: ${redactTicket(samplesUrl)}`);

  const samplesRes = await fetch(samplesUrl);
  if (!samplesRes.ok) {
    throw new Error(
      `Failed to fetch MVM samples: ${samplesRes.status} ${samplesRes.statusText}`,
    );
  }
  const rawSamples = (await samplesRes.json()) as MvmRawSample[];
  // Flatten nested observations → the flat MvmSample the join loop consumes.
  const samples: MvmSample[] = rawSamples.map(extractMvmSample);
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
