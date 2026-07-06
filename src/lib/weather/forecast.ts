import "server-only";
import { eq } from "drizzle-orm";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
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
  wind_speed_of_gust?: number;
  thunderstorm_probability?: number;
  visibility_in_air?: number;
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
/** M13: hard ceiling on a single SMHI forecast round-trip. */
const FETCH_TIMEOUT_MS = 8000;

const PARAM_KEYS: (keyof SmhiDataParams)[] = [
  "air_temperature",
  "air_pressure_at_mean_sea_level",
  "wind_speed",
  "wind_from_direction",
  "cloud_area_fraction",
  "symbol_code",
  "precipitation_amount_mean",
  "wind_speed_of_gust",
  "thunderstorm_probability",
  "visibility_in_air",
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
// Singleflight — dedupe concurrent cache-miss fetches (issue #9)
//
// cacheGet + fetch is a TOCTOU: two requests for the same lake can both miss the
// 1h cache and each fire an SMHI round-trip. This in-process map collapses
// concurrent misses onto a single in-flight fetch, keyed by lakeId. The final
// cached state is already correct (idempotent upsert) — this only saves the
// wasted upstream call.
//
// Scope caveat (mirrors the cache note above): the map is per-process, so it
// dedupes within one instance, not across pods/restarts. That's the same
// containerized-deploy caveat as the cache and is the intended trade-off here.
// ─────────────────────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<SmhiForecastDoc>>();

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

  // M13: bound the round-trip so a hung connection can't block buildSignals
  // (and the whole first turn) indefinitely — safe() catches rejections, not
  // hangs. The abort surfaces as a TimeoutError that propagates into safe().
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new TimeoutError(`SMHI forecast timed out for ${url}`, {
        service: "smhi-forecast",
        cause: err,
      });
    }
    throw new ExternalServiceError(`SMHI forecast request failed for ${url}`, {
      service: "smhi-forecast",
      cause: err,
    });
  }
  if (!res.ok) {
    // H1: throw a typed ExternalServiceError so safe()/logging can classify it
    // (and the request boundary can map e.g. 429 → rate-limited).
    throw new ExternalServiceError(
      `SMHI forecast fetch failed: ${res.status} ${res.statusText} for ${url}`,
      { status: res.status, service: "smhi-forecast" },
    );
  }

  // L14: light shape guard on unvalidated network JSON — a malformed SMHI
  // response surfaces as a clear ExternalServiceError rather than a downstream
  // undefined-access crash.
  const doc = (await res.json()) as SmhiForecastDoc;
  if (!doc || !Array.isArray(doc.timeSeries)) {
    throw new ExternalServiceError(
      `SMHI forecast returned an unexpected shape for ${url}`,
      { service: "smhi-forecast" },
    );
  }
  return doc;
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
  // M2 (Copilot #6): a transient Postgres cache read/write error must NOT sink
  // the whole forecast when SMHI is reachable — the module's contract is "cache
  // miss → live fetch". Guard both cache calls so a cache failure degrades to a
  // live fetch (read) / a still-returned doc (write) instead of dropping the
  // entire conditions Signal.
  let cached: SmhiForecastDoc | null = null;
  try {
    cached = await cacheGet(lakeId);
  } catch (err) {
    console.warn("[forecast] cacheGet failed — falling through to live", err);
  }
  if (cached) return cached;

  // Singleflight: on a concurrent miss for the same lake, join the in-flight
  // fetch instead of firing a second SMHI round-trip. The promise covers the
  // fetch and the cache write so all joiners resolve with the same doc.
  const existing = inFlight.get(lakeId);
  if (existing) return existing;

  const pending = (async () => {
    const doc = await fetchForecast(lat, lon);
    // M2: a transient cache-write error must not sink the fetched doc — the
    // contract is "cache miss → live fetch"; degrade to returning the live doc.
    try {
      await cacheSet(lakeId, doc);
    } catch (err) {
      console.warn("[forecast] cacheSet failed — returning live doc", err);
    }
    return doc;
  })().finally(() => {
    inFlight.delete(lakeId);
  });

  inFlight.set(lakeId, pending);
  return pending;
}
