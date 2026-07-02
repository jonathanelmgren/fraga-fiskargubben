/**
 * ETL: import water colour (humic/clear) and Secchi sight depth from
 * SLU Miljödata-MVM (Observations API v2).
 *
 * Run:  pnpm etl:mvm
 *
 * ## Source — VERIFIED live 2026-07-02 (needs MVM_TICKET)
 * MVM exposes a REST v2 API documented at
 *   https://miljodata.slu.se/api/docs/index.html
 * Base path: https://miljodata.slu.se/api/observations-service/v2
 * The public ticket is passed as the query parameter `token` (NOT `ticket`).
 *
 * We use the BULK chemistry export (the working path with a public ticket):
 *   GET /all-full-samples/chemistry?token=<ticket>
 * It takes ONLY `token` and returns a `{ numberOfSamples, samples[] }` envelope
 * (~1.15M samples, ~500MB).  The filtered `/full-samples/query` endpoint requires
 * filter params and returned `isAuthorized:false` with a public ticket, so the
 * bulk export is what a real run uses.
 *
 * ## Real sample shape (VERIFIED — see __fixtures__/mvm-chemistry-sample.json)
 * Each element of `samples[]` is FLAT: station info + observations are inline
 * (there is NO separate SampleSite endpoint to join — the old two-endpoint model
 * was wrong and has been removed).  Fields this ETL reads:
 *   stationEUID            — EU WFD code, e.g. "SE639339-154122" → matches
 *                            `lakes.id`.  JOIN DIRECTLY on this (like import-aqua
 *                            joins on eU_CD); no haversine for rows that carry it.
 *   stationCoordinateN/E   — SWEREF99TM northing/easting (metres).  Reprojected
 *                            to WGS84 via `sweref99ToWgs84` for the coordinate
 *                            fallback used by blank-EUID rows.
 *   stationCoordinateSystem — CRS name, e.g. "SWEREF99 TM".
 *   samplingDate           — "YYYY-MM-DD"; used to prefer more-recent samples
 *                            when several map to one lake.
 *   observations[]         — each has propertyCode / propertyAbbrevName /
 *                            propertyName + observationValues[]; each value is a
 *                            DECIMAL-COMMA string ("0,123") plus a `unit`.
 *
 * ## Confirmed property codes (propertyCode)
 *   absorbans420 → "Abs_F420".  CRITICAL: its unit is "/5cm", NOT per-metre.
 *     `deriveColour` expects A₄₂₀ in m⁻¹ (thresholds at > 0.1), so a /5cm value
 *     must be multiplied by 20 to get per-metre (0,123 /5cm → 2.46 /m).  The ×20
 *     is applied ONLY when the unit indicates a 5 cm path length (see
 *     absToPerMetre()); other units are read as already per-metre.
 *   färgtal      → "Farg".
 *   Secchi       → "Siktdjup".
 * matchesProperty() needles (abs_f420, färg, siktdjup) match these
 * case-insensitively.
 *
 * ## Architecture (ADR-0002)
 * - The MVM ticket (MVM_TICKET env var) is used HERE, at import time only.
 * - Direct EUID join → `lakes.id`; coordinate fallback via `stationMatchesLake`
 *   in `src/lib/water/station-match.ts` only for blank-EUID rows.
 * - The runtime path `src/lib/water/colour.ts#colourFor` is a pure table lookup
 *   — it does NOT import env.ts and never references MVM_TICKET.
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
 *
 * ## Memory — streamed, no OOM
 * The bulk export is ~500MB / ~1.15M samples, so the response body is parsed as a
 * STREAM (stream-json + stream-chain): the `samples[]` array is consumed
 * element-by-element and each sample is adapted on the fly, so the raw JSON is
 * never fully buffered.  A complete seed needs no memory tuning and processes
 * every sample.  `--limit N` / MVM_MAX_SAMPLES is an OPTIONAL early-stop for a
 * quick/dev run only — it is never required for a full, gap-free seed.
 */

// Pure geo util (no server-only deps) — safe to import at module scope so the
// exported adaptMvmStation can reproject SWEREF99TM → WGS84.
import { sweref99ToWgs84 } from "@/lib/geo/sweref99";

// ---------------------------------------------------------------------------
// MVM Observations API v2 — base path VERIFIED live 2026-07-02.
// The ticket is a query parameter named `token`.
// ---------------------------------------------------------------------------
const MVM_BASE_URL =
  process.env.MVM_BASE_URL ??
  "https://miljodata.slu.se/api/observations-service/v2";

/** Bulk chemistry export path — takes ONLY `token`, returns {numberOfSamples,samples}. */
const MVM_CHEMISTRY_PATH =
  process.env.MVM_CHEMISTRY_PATH ?? "/all-full-samples/chemistry";

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
// Type definitions — raw MVM v2 chemistry shapes VERIFIED live 2026-07-02;
// MvmStation/MvmSample are the flattened shapes the join loop consumes.
// ---------------------------------------------------------------------------

/** A sample station consumed by the coordinate-fallback join (from a flat sample). */
export interface MvmStation {
  /** Station identifier — the stationEUID (used for the direct lakes.id join). */
  stationId: string;
  /** EU WFD water-body code, when present (direct join on `lakes.id`). */
  euCd?: string;
  /** Station name (stationName). */
  name?: string;
  /** WGS84 latitude (reprojected from stationCoordinateN at adapt time). */
  lat: number;
  /** WGS84 longitude (reprojected from stationCoordinateE at adapt time). */
  lon: number;
}

/** One value inside an observation (VERIFIED — decimal-comma `value` + `unit`). */
export interface MvmRawObservationValue {
  value?: string | null;
  unit?: string | null;
}

/** One observed property on a sample (VERIFIED — propertyCode + observationValues). */
export interface MvmRawObservation {
  /** Machine property code, e.g. "Abs_F420" / "Farg" / "Siktdjup". */
  propertyCode?: string | null;
  /** Abbreviated property name, e.g. "Abs_F 420". */
  propertyAbbrevName?: string | null;
  propertyName?: string | null;
  observationValues?: MvmRawObservationValue[] | null;
}

/**
 * One FLAT chemistry sample from the bulk export (subset of fields this ETL
 * reads).  Station info + observations are inline — VERIFIED live 2026-07-02.
 */
export interface MvmRawChemistrySample {
  /** EU WFD water-body code, e.g. "SE639339-154122" → `lakes.id`. */
  stationEUID?: string | null;
  stationName?: string | null;
  /** SWEREF99TM northing (metres) — NOT WGS84 latitude. */
  stationCoordinateN?: number | null;
  /** SWEREF99TM easting (metres) — NOT WGS84 longitude. */
  stationCoordinateE?: number | null;
  /** Coordinate reference system name, e.g. "SWEREF99 TM". */
  stationCoordinateSystem?: string | null;
  /** Sampling date "YYYY-MM-DD" — prefer more-recent samples per lake. */
  samplingDate?: string | null;
  observations?: MvmRawObservation[] | null;
}

/** Top-level bulk-export envelope (VERIFIED — numberOfSamples is a STRING). */
export interface MvmChemistryResponse {
  numberOfSamples?: string;
  samples?: MvmRawChemistrySample[] | null;
}

/**
 * Flattened measurement extracted from a raw chemistry sample by
 * extractMvmSample() — the shape the join loop and mapMvmSample consume.  The
 * three value fields are pulled out of the nested `observations[]` by property.
 */
export interface MvmSample {
  /** Station identifier — links back to MvmStation.stationId (the stationEUID). */
  stationId: string;
  /**
   * Absorbance at 420 nm (A₄₂₀, m⁻¹) — already converted from the source /5cm
   * unit where applicable (see absToPerMetre()).  Preferred over fargtal.
   */
  absorbans420?: number | null;
  /**
   * Swedish Pt water colour number (mg Pt/L, "färgtal").
   * Fallback when absorbans420 is absent.
   */
  fargtal?: number | null;
  /** Secchi sight depth in metres. */
  siktdjupM?: number | null;
  /** Sampling date "YYYY-MM-DD" — used to prefer more-recent samples per lake. */
  samplingDate?: string | null;
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
// Raw-response adapters — bridge the real MVM v2 chemistry shapes to the flat
// shapes the join loop consumes.
// ---------------------------------------------------------------------------

/**
 * MVM property matchers for the fields we read.  VERIFIED against a live sample:
 *   absorbans420 → propertyCode "Abs_F420"
 *   färgtal      → propertyCode "Farg"
 *   Secchi       → propertyCode "Siktdjup"
 * Matching is case-insensitive against propertyCode + propertyAbbrevName +
 * propertyName so either identifier works.
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

/**
 * Parse the first finite numeric value of an observation, returning both the
 * number and its raw unit string (the caller needs the unit to convert A₄₂₀).
 * Values are decimal-comma strings ("0,123") — the comma is normalised to a dot.
 */
function firstNumericValue(
  obs: MvmRawObservation,
): { num: number; unit: string } | undefined {
  for (const v of obs.observationValues ?? []) {
    const num = Number.parseFloat((v.value ?? "").replace(",", "."));
    if (Number.isFinite(num)) return { num, unit: (v.unit ?? "").trim() };
  }
  return undefined;
}

/**
 * Convert an absorbance-420 reading to per-metre (m⁻¹) for deriveColour.
 *
 * MVM reports A₄₂₀ over a fixed optical path length, and the bulk export's unit
 * for this property is "/5cm" (absorbance measured through a 5 cm cuvette), NOT
 * per-metre.  deriveColour thresholds A₄₂₀ at > 0.1 m⁻¹, so a /5cm value must be
 * scaled to a 1 m path: 1 m / 0.05 m = ×20  (0.123 /5cm → 2.46 /m).
 *
 * The ×20 is applied ONLY when the unit indicates a 5 cm path (contains "5cm").
 * A unit that is already per-metre ("/m", "abs/m", "1/m") is passed through
 * unchanged.  Any other explicit path length ("/50mm" = 5 cm too, "/10cm", etc.)
 * is normalised generically from its parsed path length; if the unit is unknown
 * the value is returned as-is (documented risk — better than a wrong ×20).
 */
export function absToPerMetre(num: number, unit: string): number {
  const u = unit.toLowerCase().replace(/\s+/g, "");
  // Already per-metre — nothing to do.
  if (/(^|\/)m$|abs\/m|1\/m|\bm-?1\b|m⁻¹/.test(u)) return num;
  // Explicit "/5cm" (the verified MVM unit).
  if (u.includes("5cm")) return num * 20;
  // Generic "/<n>cm" or "/<n>mm" path length → scale to a 1 m path.
  const cm = u.match(/\/(\d+(?:\.\d+)?)cm/);
  if (cm) return num * (100 / Number.parseFloat(cm[1]));
  const mm = u.match(/\/(\d+(?:\.\d+)?)mm/);
  if (mm) return num * (1000 / Number.parseFloat(mm[1]));
  // Unknown unit — pass through unchanged (see docstring).
  return num;
}

/**
 * Flatten one raw chemistry sample into the MvmSample the join loop consumes,
 * pulling absorbance / färgtal / Secchi out of the nested `observations[]` by
 * property.  The A₄₂₀ reading is converted from its /5cm unit to per-metre.
 */
export function extractMvmSample(raw: MvmRawChemistrySample): MvmSample {
  const out: MvmSample = {
    stationId: (raw.stationEUID ?? "").trim(),
    samplingDate: raw.samplingDate ?? undefined,
  };
  for (const obs of raw.observations ?? []) {
    if (matchesProperty(obs, MVM_PROPERTY_MATCH.absorbans420)) {
      const hit = firstNumericValue(obs);
      if (hit) out.absorbans420 = absToPerMetre(hit.num, hit.unit);
    } else if (matchesProperty(obs, MVM_PROPERTY_MATCH.fargtal)) {
      const hit = firstNumericValue(obs);
      if (hit) out.fargtal = hit.num;
    } else if (matchesProperty(obs, MVM_PROPERTY_MATCH.siktdjup)) {
      const hit = firstNumericValue(obs);
      if (hit) out.siktdjupM = hit.num;
    }
  }
  return out;
}

/**
 * Adapt one flat chemistry sample to the coordinate-fallback MvmStation.
 * `stationId`/`euCd` are the stationEUID (for the direct lakes.id join); the
 * SWEREF99TM `stationCoordinateN/E` are reprojected to WGS84 via
 * `sweref99ToWgs84` so the haversine/stationMatchesLake fallback is meaningful.
 * Returns null when coordinates are absent or non-finite.
 */
export function adaptMvmStation(raw: MvmRawChemistrySample): MvmStation | null {
  const north = raw.stationCoordinateN;
  const east = raw.stationCoordinateE;
  if (typeof north !== "number" || typeof east !== "number") return null;
  const wgs = sweref99ToWgs84(north, east);
  if (!wgs) return null;
  const euCd = (raw.stationEUID ?? "").trim();
  return {
    stationId: euCd,
    euCd: euCd || undefined,
    name: raw.stationName ?? undefined,
    lat: wgs.lat,
    lon: wgs.lon,
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

  // Optional early-stop for a quick/dev run: `--limit N` (CLI) or MVM_MAX_SAMPLES
  // (env) stops parsing after N samples.  Absent/0 = process EVERY sample (the
  // response is streamed, so there is no memory reason to cap — this is only for
  // a fast partial run, never needed for a complete seed).
  const limitArg = process.argv
    .find((a) => a.startsWith("--limit="))
    ?.slice("--limit=".length);
  const maxSamples =
    Number.parseInt(limitArg ?? process.env.MVM_MAX_SAMPLES ?? "", 10) || 0;

  // Lazy imports — DB / server-only code never loaded by pure tests.
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  const { sql } = await import("drizzle-orm");
  const { waterColour, lakes } = await import("@/shared/db/schema");
  const { stationMatchesLake } = await import("@/lib/water/station-match");
  const { haversine } = await import("@/lib/geo/haversine");
  // Streaming JSON parser: the chemistry export is ~500MB, so we parse the
  // `samples[]` array element-by-element off the response stream instead of
  // buffering the whole body with res.json() (which OOMs). No sample is skipped.
  const { Readable } = await import("node:stream");
  const { chain } = await import("stream-chain");
  const { parser } = await import("stream-json");
  const { pick } = await import("stream-json/filters/pick.js");
  const { streamArray } = await import("stream-json/streamers/stream-array.js");

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

  // ── 2. Stream the bulk chemistry export + adapt each sample on the fly ─────
  //   The response is ~500MB / ~1.15M samples, so we parse the `samples[]` array
  //   element-by-element off the response stream (stream-json) and adapt+extract
  //   each as it arrives — the raw JSON is never buffered, so nothing OOMs and no
  //   sample is skipped.  The kept structures (samples[] + stationMap) hold only
  //   the small extracted fields, not the raw payload.
  //
  //   One flat sample = one station (by stationEUID) + one measurement.  The
  //   station is only needed for the coordinate fallback (blank-EUID rows); the
  //   extracted MvmSample carries the EUID directly for the O(1) join.
  const samplesUrl = `${MVM_BASE_URL}${MVM_CHEMISTRY_PATH}?token=${encodeURIComponent(ticket)}`;
  console.log(
    `Streaming MVM chemistry bulk export from: ${redactTicket(samplesUrl)}`,
  );

  const samplesRes = await fetch(samplesUrl);
  if (!samplesRes.ok || samplesRes.body === null) {
    throw new Error(
      `Failed to fetch MVM chemistry export: ${samplesRes.status} ${samplesRes.statusText}`,
    );
  }

  const samples: MvmSample[] = [];
  const stationMap = new Map<string, MvmStation>();

  // web ReadableStream (fetch body) → Node Readable → stream-json chain: parse
  // JSON tokens → pick the `samples` array → assemble one { key, value } per
  // element.  stream-json v3 composes via stream-chain's chain([...]); the chain
  // is an async-iterable Node stream, so we consume it with for-await.
  const nodeStream = Readable.fromWeb(
    samplesRes.body as Parameters<typeof Readable.fromWeb>[0],
  );
  const pipeline = chain([
    nodeStream,
    parser(),
    pick({ filter: "samples" }),
    streamArray(),
  ]);

  let seen = 0;
  for await (const { value } of pipeline as AsyncIterable<{
    value: MvmRawChemistrySample;
  }>) {
    const sample = extractMvmSample(value);
    samples.push(sample);
    // Index the station for the coordinate fallback, keyed by stationId (EUID or
    // the reprojected coordinates for blank-EUID rows).
    const station = adaptMvmStation(value);
    if (station) {
      const key =
        station.stationId || `mvm-coord-${station.lat},${station.lon}`;
      station.stationId = key;
      sample.stationId = sample.stationId || key;
      if (!stationMap.has(key)) stationMap.set(key, station);
    }
    seen++;
    if (maxSamples > 0 && seen >= maxSamples) {
      console.log(`Stopping early at ${maxSamples} samples (--limit).`);
      nodeStream.destroy();
      break;
    }
  }
  console.log(`Adapted ${samples.length} MVM samples (streamed).`);

  // ── 4. Join station → lake at import time (ADR-0002) ─────────────────────
  const rows: ColourRow[] = [];
  let skipped = 0;
  let noMatch = 0;

  // Best sample per lake: prefer high confidence, then the more-recent
  // samplingDate (chemistry time-series often has many samples per lake).
  const bestByLake = new Map<
    string,
    { row: ColourRow; samplingDate: string }
  >();

  // Two-tier join, mirroring import-aqua.ts §6:
  //   (a) DIRECT — samples carrying `stationEUID` join straight on `lakes.id` in
  //       O(1), high confidence, no haversine.
  //   (b) COORDINATE FALLBACK — blank-EUID rows fall through to the centroid
  //       join, with a bounding-box pre-filter + per-station memo so it is
  //       O(fallback-stations × local-lakes).  [~] deferred: PostGIS spatial join.
  const lakeById = new Map(lakeCandidates.map((lake) => [lake.id, lake]));

  /** ~degrees of latitude per km; lakes farther than the area radius can't match. */
  const BBOX_DEG = 0.6; // ~66 km half-window — generous vs largest area radii

  type StationMatch = { lakeId: string; confidence: "high" | "low" } | null;
  const matchByStation = new Map<string, StationMatch>();

  function joinToLake(sample: MvmSample): StationMatch {
    // (a) Direct EUID join — no coordinate math when the lake PK is present.
    const euCd = sample.stationId;
    if (euCd) {
      const lake = lakeById.get(euCd);
      if (lake) return { lakeId: lake.id, confidence: "high" };
      // EUID present but not in our lakes table → fall through to coordinates.
    }

    // (b) Coordinate fallback (needs a station with reprojected coordinates).
    const station = stationMap.get(sample.stationId);
    if (!station) return null;

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
    const matched = joinToLake(sample);
    if (matched === null) {
      noMatch++;
      continue;
    }

    let row: ColourRow;
    try {
      row = mapMvmSample(sample, matched.lakeId, matched.confidence);
    } catch (err) {
      skipped++;
      console.warn(
        `Skipping sample for station ${sample.stationId}: ${(err as Error).message}`,
      );
      continue;
    }

    // Keep high-confidence over low; within the same confidence prefer the
    // more-recent samplingDate (ISO "YYYY-MM-DD" sorts lexicographically).
    const date = sample.samplingDate ?? "";
    const existing = bestByLake.get(matched.lakeId);
    const isBetter =
      !existing ||
      (row.confidence === "high" && existing.row.confidence === "low") ||
      (row.confidence === existing.row.confidence &&
        date > existing.samplingDate);
    if (isBetter) {
      bestByLake.set(matched.lakeId, { row, samplingDate: date });
    }
  }

  for (const { row } of bestByLake.values()) rows.push(row);

  // ── 5. Batch upsert (chunked) ──────────────────────────────────────────────
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
