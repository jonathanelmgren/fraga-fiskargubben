import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db/client";
import { forecastCache } from "@/shared/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SmhiDataParams = {
  air_temperature?: number;
  air_pressure_at_mean_sea_level?: number;
  wind_speed?: number;
  wind_from_direction?: number;
  cloud_area_fraction?: number;
  symbol_code?: number;
  precipitation_amount_mean?: number;
};

export type SmhiTimeSeriesEntry = {
  time: string; // UTC ISO-8601
  data: Record<string, number>;
};

export type SmhiForecastDoc = {
  geometry: {
    type: string;
    coordinates: [number, number]; // [lon, lat]
  };
  timeSeries: SmhiTimeSeriesEntry[];
};

export type PickResult = {
  entry: SmhiTimeSeriesEntry;
  snapDeltaMinutes: number;
  params: SmhiDataParams;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SMHI_BASE =
  "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point";

const SENTINEL = 9999;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const PARAM_KEYS: (keyof SmhiDataParams)[] = [
  "air_temperature",
  "air_pressure_at_mean_sea_level",
  "wind_speed",
  "wind_from_direction",
  "cloud_area_fraction",
  "symbol_code",
  "precipitation_amount_mean",
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when fetchedAt is strictly less than 1h before now.
 * Pure — no I/O. Exported so tests can verify the TTL logic without DB.
 */
export function isFresh(fetchedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - fetchedAt.getTime() < CACHE_TTL_MS;
}

/**
 * Extract named params from an entry's data object, filtering sentinel 9999.
 * All times in the SMHI response are UTC ISO strings — no conversion needed here.
 */
function extractParams(data: Record<string, number>): SmhiDataParams {
  const params: SmhiDataParams = {};
  for (const key of PARAM_KEYS) {
    const val = data[key];
    if (val !== undefined && val !== SENTINEL) {
      params[key] = val;
    }
  }
  return params;
}

/**
 * Pick the timeSeries entry nearest to targetTimeUtc.
 * targetTimeUtc must be a UTC ISO-8601 string (caller's responsibility).
 * Times in the SMHI doc are already UTC — comparison is done in epoch ms.
 * Tie-break: later entry wins (>= comparison).
 *
 * Returns the entry, snap delta in minutes, and extracted params (9999 filtered).
 */
export function pickEntry(
  doc: SmhiForecastDoc,
  targetTimeUtc: string,
): PickResult {
  if (doc.timeSeries.length === 0) {
    throw new Error("SMHI returned an empty timeSeries");
  }

  const targetMs = new Date(targetTimeUtc).getTime();

  let best = doc.timeSeries[0];
  let bestDiff = Math.abs(new Date(best.time).getTime() - targetMs);

  for (const entry of doc.timeSeries.slice(1)) {
    const diff = Math.abs(new Date(entry.time).getTime() - targetMs);
    if (diff <= bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }

  return {
    entry: best,
    snapDeltaMinutes: Math.round(bestDiff / 60_000),
    params: extractParams(best.data),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache — Postgres forecast_cache table (ADR-0002)
//
// Choice rationale: Postgres over in-process Map because:
//   1. The app is containerized (potentially multi-instance) — a Map is
//      not shared across pods/restarts.
//   2. Postgres is already the primary store; no new infrastructure.
//   3. A single upsert + select is negligible overhead vs the SMHI round-trip.
// Caveat: a cold start with no DB still works (cache miss → live fetch).
// ─────────────────────────────────────────────────────────────────────────────

async function cacheGet(lakeId: string): Promise<SmhiForecastDoc | null> {
  const rows = await db
    .select()
    .from(forecastCache)
    .where(eq(forecastCache.lakeId, lakeId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  if (!isFresh(row.fetchedAt)) return null;

  return row.doc as SmhiForecastDoc;
}

async function cacheSet(lakeId: string, doc: SmhiForecastDoc): Promise<void> {
  await db
    .insert(forecastCache)
    .values({ lakeId, fetchedAt: new Date(), doc })
    .onConflictDoUpdate({
      target: forecastCache.lakeId,
      set: { fetchedAt: new Date(), doc },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the SMHI snow1g forecast for a point.
 * Does NOT cache — use getForecast for the cached wrapper.
 * Exported for testing with a mocked fetch.
 */
export async function fetchForecast(
  lat: number,
  lon: number,
): Promise<SmhiForecastDoc> {
  // Coordinate precision: SMHI requires max 4 decimal places for snow1g.
  const lonStr = lon.toFixed(4);
  const latStr = lat.toFixed(4);
  const url = `${SMHI_BASE}/lon/${lonStr}/lat/${latStr}/data.json`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `SMHI forecast fetch failed: ${res.status} ${res.statusText} for ${url}`,
    );
  }

  return res.json() as Promise<SmhiForecastDoc>;
}

/**
 * Return the SMHI snow1g forecast doc for a lake, using the 1h Postgres cache.
 * On cache miss or stale entry, fetches live and updates the cache.
 */
export async function getForecast(
  lakeId: string,
  lat: number,
  lon: number,
): Promise<SmhiForecastDoc> {
  const cached = await cacheGet(lakeId);
  if (cached) return cached;

  const doc = await fetchForecast(lat, lon);
  await cacheSet(lakeId, doc);
  return doc;
}
