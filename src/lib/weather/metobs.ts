import "server-only";
import { eq } from "drizzle-orm";
import { haversine } from "@/lib/geo/haversine";
import { db } from "@/shared/db/client";
import { metobsStations } from "@/shared/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MetobsParameter = "pressure" | "temp";

/**
 * A single raw obs entry from the SMHI metobs API.
 * `date` is epoch ms; `value` is the string numeric value.
 */
export type RawObsEntry = { date: number; value: string };

/**
 * A set of raw observation arrays for the four conditions parameters.
 * Passed to mapObsToConditions; any array may be empty if that parameter
 * had no data for the requested time window.
 */
export type RawObsSet = {
  temp: RawObsEntry[];
  pressure: RawObsEntry[];
  windSpeed: RawObsEntry[];
  windDir: RawObsEntry[];
};

/**
 * Observed conditions at a specific target time, drawn from metobs actuals.
 *
 * Field names are intentionally aligned with the forecast path's SmhiDataParams
 * so Phase 4 buildSignals can consume both paths with the same shape:
 *   air_temperature               — °C
 *   air_pressure_at_mean_sea_level — hPa
 *   wind_speed                    — m/s
 *   wind_from_direction           — degrees (0–360)
 *   source                        — always "observed" for this type
 *
 * Only fields with actual data are populated; missing parameters are undefined.
 */
export type ObservedConditions = {
  air_temperature?: number;
  air_pressure_at_mean_sea_level?: number;
  wind_speed?: number;
  wind_from_direction?: number;
  source: "observed";
};

export type MetobsStation = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  parameter: string;
};

export type NearestStationResult = {
  station: MetobsStation;
  distanceKm: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure classifiers — no I/O; exported for unit testing
// ─────────────────────────────────────────────────────────────────────────────

/** Stable threshold: |Δ pressure| < 1.5 hPa over ~24 h. */
const PRESSURE_STABLE_THRESHOLD_HPA = 1.5;

/**
 * Classify a 24h pressure delta into a trend.
 * deltaHpa = end_pressure − start_pressure.
 */
export function classifyPressureTrend(
  deltaHpa: number,
): "rising" | "falling" | "stable" {
  if (deltaHpa >= PRESSURE_STABLE_THRESHOLD_HPA) return "rising";
  if (deltaHpa <= -PRESSURE_STABLE_THRESHOLD_HPA) return "falling";
  return "stable";
}

/** Steady threshold: |Δ temp| < 2 °C over ~5 d. */
const TEMP_STEADY_THRESHOLD_C = 2;

/**
 * Classify a 5-day temperature delta into a trend.
 * deltaC = end_temp − start_temp.
 */
export function classifyTempTrend(
  deltaC: number,
): "warming" | "cooling" | "steady" {
  if (deltaC >= TEMP_STEADY_THRESHOLD_C) return "warming";
  if (deltaC <= -TEMP_STEADY_THRESHOLD_C) return "cooling";
  return "steady";
}

/**
 * Confidence rule (ADR-0002, spec §3): if the nearest temperature station is
 * more than 40 km from the lake, the LLM must hedge its temperature-trend
 * claim. A station at exactly 40 km is still considered close enough for high
 * confidence.
 */
export function tempConfidence(distanceKm: number): "high" | "low" {
  return distanceKm > 40 ? "low" : "high";
}

/**
 * ADR-0002 dual-source switch.
 *
 * Returns "observed" when targetTimeUtc is strictly before `now`,
 * "forecast" when it equals now or is in the future.
 *
 * Boundary decision: "now" is not past — observations may lag by minutes, so
 * the current moment always uses the forecast path. This is conservative and
 * correct: if the user queries "right now", we have a forecast but may not
 * yet have an observation indexed for this exact second.
 *
 * @param targetTimeUtc  UTC ISO-8601 string of the conditions target time.
 * @param now            Injected for testability; defaults to `new Date()`.
 */
export function conditionsSource(
  targetTimeUtc: string,
  now: Date = new Date(),
): "forecast" | "observed" {
  return new Date(targetTimeUtc).getTime() < now.getTime()
    ? "observed"
    : "forecast";
}

/**
 * Pick the observation entry nearest to targetTimeUtc.
 * Tie-break: first (earlier) entry wins — observations lean toward confirmed
 * historical data rather than the later boundary.
 * Returns undefined when the array is empty.
 * Pure — no I/O.
 */
function pickNearestObs(
  obs: RawObsEntry[],
  targetTimeUtc: string,
): number | undefined {
  if (obs.length === 0) return undefined;

  const targetMs = new Date(targetTimeUtc).getTime();
  let best = obs[0];
  let bestDiff = Math.abs(best.date - targetMs);

  for (const entry of obs.slice(1)) {
    const diff = Math.abs(entry.date - targetMs);
    if (diff < bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }

  const num = Number.parseFloat(best.value);
  return Number.isNaN(num) ? undefined : num;
}

/**
 * Map a set of raw metobs observation arrays to ObservedConditions.
 *
 * Each parameter is independently nearest-picked relative to targetTimeUtc.
 * Fields without data are omitted (undefined). source is always "observed".
 *
 * Pure — no I/O; exported for fixture testing.
 */
export function mapObsToConditions(
  obs: RawObsSet,
  targetTimeUtc: string,
): ObservedConditions {
  return {
    air_temperature: pickNearestObs(obs.temp, targetTimeUtc),
    air_pressure_at_mean_sea_level: pickNearestObs(obs.pressure, targetTimeUtc),
    wind_speed: pickNearestObs(obs.windSpeed, targetTimeUtc),
    wind_from_direction: pickNearestObs(obs.windDir, targetTimeUtc),
    source: "observed",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearest-station cache
//
// A simple in-process Map keyed by "${lat}:${lon}:${parameter}".
// Caveat: this cache is per-process and not shared across containers/restarts.
// For a multi-instance deployment the cache should be moved to Postgres (or
// Redis). For now, the station list is small (~hundreds of rows) and the
// lookup is fast, so this is acceptable.
// ─────────────────────────────────────────────────────────────────────────────

const nearestCache = new Map<string, NearestStationResult | null>();

/**
 * Return the nearest metobs station (for the given parameter) to a lake
 * coordinate, plus the distance in kilometres.
 *
 * Implementation note: we load all stations for the parameter (~hundreds of
 * rows) and compute haversine in JS. A SQL-side distance computation (e.g.
 * with PostGIS or inline trigonometry) would be more efficient but is not
 * required at this scale.
 */
export async function nearestStation(
  lake: { lat: number; lon: number },
  parameter: MetobsParameter,
): Promise<NearestStationResult | null> {
  const key = `${lake.lat}:${lake.lon}:${parameter}`;
  if (nearestCache.has(key)) {
    return nearestCache.get(key) ?? null;
  }

  const rows = await db
    .select()
    .from(metobsStations)
    .where(eq(metobsStations.parameter, parameter));

  if (rows.length === 0) {
    nearestCache.set(key, null);
    return null;
  }

  let best = rows[0];
  let bestDist = haversine(lake, { lat: best.lat, lon: best.lon });

  for (const row of rows.slice(1)) {
    const dist = haversine(lake, { lat: row.lat, lon: row.lon });
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }

  const result: NearestStationResult = {
    station: best,
    distanceKm: bestDist,
  };
  nearestCache.set(key, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation fetch helpers
//
// PLACEHOLDER — the exact SMHI metobs observation endpoint URL has NOT been
// confirmed. Set METOBS_OBS_URL to the verified path with {stationId} and
// {period} placeholders; see scripts/etl/README.md for the base URL convention.
//
// Example (unverified): /api/version/1.0/parameter/{p}/station/{s}/period/{period}/data.json
// Controlled by env var METOBS_OBS_URL (with METOBS_BASE as base).
// ─────────────────────────────────────────────────────────────────────────────

type ObsValue = { date: string; value: number };

async function fetchObservations(
  stationId: string,
  parameterId: number,
  period: "latest-day" | "latest-months",
): Promise<ObsValue[]> {
  const base =
    process.env.METOBS_BASE ?? "https://opendata-download-metobs.smhi.se";
  // PLACEHOLDER: path pattern is unverified — operator must confirm against
  // https://opendata.smhi.se/apidocs/metobs/ before relying on this.
  const pathTemplate =
    process.env.METOBS_OBS_URL ??
    "/api/version/1.0/parameter/{p}/station/{s}/period/{period}/data.json";

  const url = `${base}${pathTemplate
    .replace("{p}", String(parameterId))
    .replace("{s}", stationId)
    .replace("{period}", period)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `metobs observation fetch failed: ${res.status} ${res.statusText} for ${url}`,
    );
  }

  // SMHI returns a JSON structure; extract the numeric values.
  // The exact shape depends on the endpoint — adapt this parser once the real
  // endpoint is confirmed.
  type SmhiObsDoc = {
    value?: Array<{ date: number; value: string }>;
  };
  const doc: SmhiObsDoc = (await res.json()) as SmhiObsDoc;
  if (!Array.isArray(doc.value)) return [];

  return doc.value.flatMap((entry) => {
    const num = Number.parseFloat(entry.value);
    if (Number.isNaN(num)) return [];
    return [{ date: new Date(entry.date).toISOString(), value: num }];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public trend API
// ─────────────────────────────────────────────────────────────────────────────

/** SMHI parameter id for air pressure. */
const PRESSURE_PARAM_ID = 9;
/** SMHI parameter id for air temperature. */
const TEMP_PARAM_ID = 1;

/**
 * Fetch ~24h of pressure observations for the station and classify the trend.
 * The classification (classifyPressureTrend) is pure and separately tested.
 */
export async function pressureTrend24h(
  stationId: string,
): Promise<"rising" | "falling" | "stable"> {
  const obs = await fetchObservations(
    stationId,
    PRESSURE_PARAM_ID,
    "latest-day",
  );
  if (obs.length < 2) return "stable";

  const first = obs[0].value;
  const last = obs[obs.length - 1].value;
  return classifyPressureTrend(last - first);
}

/**
 * Fetch ~5d of temperature observations for the station and classify the
 * trend. If distanceKm > 40, marks confidence 'low' (ADR-0002, spec §3).
 */
export async function airTempTrend5d(
  stationId: string,
  distanceKm: number,
): Promise<{
  trend: "warming" | "cooling" | "steady";
  confidence: "high" | "low";
}> {
  const obs = await fetchObservations(
    stationId,
    TEMP_PARAM_ID,
    "latest-months",
  );
  const confidence = tempConfidence(distanceKm);

  if (obs.length < 2) {
    return { trend: "steady", confidence };
  }

  // Use oldest and newest within the ~5d window
  const first = obs[0].value;
  const last = obs[obs.length - 1].value;
  return { trend: classifyTempTrend(last - first), confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Observed conditions (past-time actuals path) — ADR-0002 dual source
//
// SMHI parameter ids for conditions fetch:
//   1  = air temperature (°C)
//   9  = air pressure at mean sea level (hPa)
//   4  = wind speed (m/s)         [PLACEHOLDER: verify against SMHI docs]
//   3  = wind direction (degrees) [PLACEHOLDER: verify against SMHI docs]
//
// The fetch uses the same PLACEHOLDER endpoint pattern as the trend fetch above.
// Operator must confirm param ids + URL against https://opendata.smhi.se/apidocs/metobs/
// ─────────────────────────────────────────────────────────────────────────────

/** SMHI parameter id for wind speed (PLACEHOLDER — verify against SMHI docs). */
const WIND_SPEED_PARAM_ID = 4;
/** SMHI parameter id for wind from direction (PLACEHOLDER — verify against SMHI docs). */
const WIND_DIR_PARAM_ID = 3;

/**
 * Fetch raw observation entries (date as epoch ms, value as string) for a
 * single SMHI metobs parameter. Keeps the raw shape so mapObsToConditions can
 * do nearest-time picking without double-parsing.
 *
 * PLACEHOLDER: endpoint URL and parameter ids are unverified — see comment above.
 */
async function fetchRawObs(
  stationId: string,
  parameterId: number,
  period: "latest-day" | "latest-months",
): Promise<RawObsEntry[]> {
  const base =
    process.env.METOBS_BASE ?? "https://opendata-download-metobs.smhi.se";
  // PLACEHOLDER: path pattern is unverified — operator must confirm against
  // https://opendata.smhi.se/apidocs/metobs/ before relying on this.
  const pathTemplate =
    process.env.METOBS_OBS_URL ??
    "/api/version/1.0/parameter/{p}/station/{s}/period/{period}/data.json";

  const url = `${base}${pathTemplate
    .replace("{p}", String(parameterId))
    .replace("{s}", stationId)
    .replace("{period}", period)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `metobs raw observation fetch failed: ${res.status} ${res.statusText} for ${url}`,
    );
  }

  type SmhiObsDoc = {
    value?: Array<{ date: number; value: string }>;
  };
  const doc: SmhiObsDoc = (await res.json()) as SmhiObsDoc;
  if (!Array.isArray(doc.value)) return [];

  return doc.value;
}

/**
 * Fetch metobs actual observations around `targetTimeUtc` for a station and
 * return them as ObservedConditions (same shape as the forecast conditions path,
 * each field marked source: "observed").
 *
 * For past target times only (use conditionsSource() to decide which path to call).
 *
 * PLACEHOLDER: parameter ids and endpoint URL are unverified — see module-level
 * comment. Fetches "latest-day" for all four parameters; if targetTimeUtc is
 * more than ~24h in the past, data may be absent and fields will be undefined.
 */
export async function observedConditions(
  stationId: string,
  targetTimeUtc: string,
): Promise<ObservedConditions> {
  const [temp, pressure, windSpeed, windDir] = await Promise.all([
    fetchRawObs(stationId, TEMP_PARAM_ID, "latest-day"),
    fetchRawObs(stationId, PRESSURE_PARAM_ID, "latest-day"),
    fetchRawObs(stationId, WIND_SPEED_PARAM_ID, "latest-day"),
    fetchRawObs(stationId, WIND_DIR_PARAM_ID, "latest-day"),
  ]);

  return mapObsToConditions(
    { temp, pressure, windSpeed, windDir },
    targetTimeUtc,
  );
}
