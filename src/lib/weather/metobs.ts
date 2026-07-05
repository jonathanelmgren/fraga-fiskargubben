import "server-only";
import { and, eq } from "drizzle-orm";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import { haversine } from "@/lib/geo/haversine";
import { db } from "@/shared/db/client";
import { metobsStations } from "@/shared/db/schema";

/** M13: hard ceiling on a single metobs observation round-trip. */
const METOBS_FETCH_TIMEOUT_MS = 8000;

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
  /**
   * #8: how far (minutes) the nearest populated observation is from the
   * requested target time — the largest offset across the populated params.
   * Analogous to the forecast path's `snapDeltaMinutes`.  For a target time
   * well within the fetched window this is small; for a target > ~24h in the
   * past (outside "latest-day") the nearest obs can be many hours off, and
   * buildSignals uses this to downgrade confidence + flag staleness so the
   * LLM can hedge.  undefined when no parameter had any observation.
   */
  snapDeltaMinutes?: number;
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
): { value: number; offsetMs: number } | undefined {
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
  // #8: carry the offset so the caller can flag how stale the nearest obs is.
  return Number.isNaN(num) ? undefined : { value: num, offsetMs: bestDiff };
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
  const temp = pickNearestObs(obs.temp, targetTimeUtc);
  const pressure = pickNearestObs(obs.pressure, targetTimeUtc);
  const windSpeed = pickNearestObs(obs.windSpeed, targetTimeUtc);
  const windDir = pickNearestObs(obs.windDir, targetTimeUtc);

  // #8: staleness = the LARGEST offset across the populated params.  Taking the
  // max (not min) is the honest choice — if any field the LLM will use is far
  // from the target, the whole observed snapshot should be treated as stale.
  const offsets = [temp, pressure, windSpeed, windDir]
    .filter((p): p is { value: number; offsetMs: number } => p !== undefined)
    .map((p) => p.offsetMs);
  const snapDeltaMinutes =
    offsets.length > 0 ? Math.round(Math.max(...offsets) / 60_000) : undefined;

  return {
    air_temperature: temp?.value,
    air_pressure_at_mean_sea_level: pressure?.value,
    wind_speed: windSpeed?.value,
    wind_from_direction: windDir?.value,
    source: "observed",
    snapDeltaMinutes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearest-station cache
//
// A bounded in-process LRU keyed by "${lat}:${lon}:${parameter}".
// M11: previously an unbounded Map that cached null permanently and grew
// without limit.  Now capped at NEAREST_CACHE_MAX entries with LRU eviction
// (re-insert on hit moves the key to the most-recently-used position) so
// memory growth is bounded.  Still per-process (not shared across serverless
// instances) — a Postgres/Redis-backed cache is out of scope here.
// [~] deferred: cross-instance (Postgres/Redis) cache.
// ─────────────────────────────────────────────────────────────────────────────

const NEAREST_CACHE_MAX = 500;
const nearestCache = new Map<string, NearestStationResult | null>();

function nearestCacheGet(key: string): NearestStationResult | null | undefined {
  if (!nearestCache.has(key)) return undefined;
  const value = nearestCache.get(key) ?? null;
  // LRU touch: delete + re-insert moves the key to the most-recent position.
  nearestCache.delete(key);
  nearestCache.set(key, value);
  return value;
}

function nearestCacheSet(
  key: string,
  value: NearestStationResult | null,
): void {
  if (nearestCache.has(key)) nearestCache.delete(key);
  nearestCache.set(key, value);
  // Evict the least-recently-used entry (first key in insertion order).
  if (nearestCache.size > NEAREST_CACHE_MAX) {
    const oldest = nearestCache.keys().next().value;
    if (oldest !== undefined) nearestCache.delete(oldest);
  }
}

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
  const cached = nearestCacheGet(key);
  if (cached !== undefined) {
    return cached;
  }

  // Inactive stations remain in the SMHI list but 404 on latest-* data
  // endpoints (e.g. station 83540, last observation 1996) — only active
  // stations are candidates.
  const rows = await db
    .select()
    .from(metobsStations)
    .where(
      and(
        eq(metobsStations.parameter, parameter),
        eq(metobsStations.active, true),
      ),
    );

  if (rows.length === 0) {
    nearestCacheSet(key, null);
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
  nearestCacheSet(key, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation fetch helpers
//
// VERIFIED against the live SMHI metobs API 2026-07-01.  The observation URL
// pattern (from the api.json entry point) is:
//   /api/version/{version}/parameter/{parameter}/station/{station}/period/{period}/data.json
// Live-checked: GET .../parameter/1/station/{active}/period/latest-day/data.json
//   → { ..., "value": [ { "date": <epoch ms>, "value": "8.9", "quality": "G" } ] }
// Valid periods: latest-hour, latest-day, latest-months, corrected-archive.
// Overridable via METOBS_OBS_URL ({p},{s},{period}) with METOBS_BASE as base.
// Docs: https://opendata.smhi.se/apidocs/metobs/
// ─────────────────────────────────────────────────────────────────────────────

type ObsValue = { date: string; value: number };

/**
 * H12: map raw obs entries (date epoch ms, value string) → parsed ObsValue
 * (date ISO string, value number), dropping non-numeric entries.  Used by the
 * trend fetchers which previously had a duplicated ~40-line fetcher.
 */
function mapRawToObsValues(raw: RawObsEntry[]): ObsValue[] {
  return raw.flatMap((entry) => {
    const num = Number.parseFloat(entry.value);
    if (Number.isNaN(num)) return [];
    return [{ date: new Date(entry.date).toISOString(), value: num }];
  });
}

/**
 * H12: the single raw observation fetcher.  `fetchObservations` is now just a
 * thin mapper over this (was a near-identical duplicate differing only in the
 * final mapping).
 */
async function fetchObservations(
  stationId: string,
  parameterId: number,
  period: "latest-day" | "latest-months",
): Promise<ObsValue[]> {
  const raw = await fetchRawObs(stationId, parameterId, period);
  return mapRawToObsValues(raw);
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
  // metobs has no native "last 5 days" period: latest-day is only ~24h, and the
  // next-widest, latest-months, returns the last full month(s).  So we fetch
  // latest-months and narrow to the trailing 5-day window ourselves — otherwise
  // the trend would span weeks, not the intended 5 days (spec §3).
  const obs = await fetchObservations(
    stationId,
    TEMP_PARAM_ID,
    "latest-months",
  );
  const confidence = tempConfidence(distanceKm);

  const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - FIVE_DAYS_MS;
  const windowed = obs.filter((o) => Date.parse(o.date) >= cutoff);

  if (windowed.length < 2) {
    return { trend: "steady", confidence };
  }

  // Use oldest and newest within the 5-day window.
  const first = windowed[0].value;
  const last = windowed[windowed.length - 1].value;
  return { trend: classifyTempTrend(last - first), confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Observed conditions (past-time actuals path) — ADR-0002 dual source
//
// SMHI parameter ids for conditions fetch — VERIFIED against the live API
// 2026-07-01 (GET .../parameter/{id}.json → title/unit):
//   1  = Lufttemperatur — air temperature (°C)
//   9  = Lufttryck reducerat havsytans nivå — air pressure at mean sea level (hPa)
//   4  = Vindhastighet — wind speed (m/s)
//   3  = Vindriktning — wind direction (degrees)
// (For reference: 21 = Byvind/gust, 25 = max of 10-min mean — not used here.)
// Docs: https://opendata.smhi.se/apidocs/metobs/
// ─────────────────────────────────────────────────────────────────────────────

/** SMHI parameter id for wind speed (Vindhastighet, m/s) — verified 2026-07-01. */
const WIND_SPEED_PARAM_ID = 4;
/** SMHI parameter id for wind from direction (Vindriktning, degrees) — verified 2026-07-01. */
const WIND_DIR_PARAM_ID = 3;

/**
 * Fetch raw observation entries (date as epoch ms, value as string) for a
 * single SMHI metobs parameter. Keeps the raw shape so mapObsToConditions can
 * do nearest-time picking without double-parsing.
 *
 * Endpoint verified against the live API 2026-07-01 (see module comment above).
 */
async function fetchRawObs(
  stationId: string,
  parameterId: number,
  period: "latest-day" | "latest-months",
): Promise<RawObsEntry[]> {
  const base =
    process.env.METOBS_BASE ?? "https://opendata-download-metobs.smhi.se";
  // Verified path pattern (see module comment above); overridable via env.
  const pathTemplate =
    process.env.METOBS_OBS_URL ??
    "/api/version/1.0/parameter/{p}/station/{s}/period/{period}/data.json";

  const url = `${base}${pathTemplate
    .replace("{p}", String(parameterId))
    .replace("{s}", stationId)
    .replace("{period}", period)}`;

  // M13: bound the round-trip so a hung metobs connection can't block the first
  // turn indefinitely. The abort surfaces as a TimeoutError into safe().
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(METOBS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new TimeoutError(`metobs observation timed out for ${url}`, {
        service: "smhi-metobs",
        cause: err,
      });
    }
    throw new ExternalServiceError(`metobs request failed for ${url}`, {
      service: "smhi-metobs",
      cause: err,
    });
  }
  if (!res.ok) {
    // H1: typed error so safe()/logging can classify upstream failures.
    throw new ExternalServiceError(
      `metobs raw observation fetch failed: ${res.status} ${res.statusText} for ${url}`,
      { status: res.status, service: "smhi-metobs" },
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
