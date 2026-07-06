/**
 * buildSignals — Phase 4 capstone orchestrator.
 *
 * Assembles a Signals object from all data sources (forecast/observed,
 * metobs trends, water temp/depth/colour/species) and derives the
 * secondary signals (light window, windward shore, species comfort).
 *
 * ADR-0002 compliance:
 *  - Each source call is independently wrapped; a missing/throwing source
 *    results in the corresponding Signal being absent — buildSignals never
 *    throws because a source is unavailable.
 *  - A `source_miss` analytics event is emitted for each absent/failed source.
 *  - A `signals_built` event is emitted on success.
 *
 * Testability: `now` is required in the input so the function is fully
 * deterministic; no argless `new Date()` / `Date.now()` calls inside.
 */

import { emit } from "@/lib/analytics/events";
import { formatStockholmLocal, stockholmParts } from "@/lib/time/stockholm";
import { colourFor } from "@/lib/water/colour";
import { depthFor } from "@/lib/water/depth";
import { speciesFor } from "@/lib/water/species";
import type { AirTempTrend, Season } from "@/lib/water/temp";
import { waterTempFor } from "@/lib/water/temp";
import { getForecast, pickEntry } from "@/lib/weather/forecast";
import {
  airTempTrend5d,
  conditionsSource,
  nearestStation,
  observedConditions,
  pressureTrend24h,
  tempConfidence,
} from "@/lib/weather/metobs";
import { octasToPercent, probabilityPct } from "@/lib/weather/units";
import { lightWindow, sunTimes } from "./light";
import { speciesComfort } from "./species-comfort";
import type { Provenance, Signals, Source, WithProvenance } from "./types";
import { describeWindDirection, windwardShore } from "./wind";

// ────────────────────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────────────────────

export interface BuildSignalsInput {
  lake: {
    id: string;
    name: string;
    label: string;
    lat: number;
    lon: number;
    areaHa: number;
  };
  targetTime: Date;
  /** Injected clock — required for deterministic behaviour and source selection. */
  now: Date;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Wrap a value with provenance. */
function wp<T>(
  value: T,
  source: Source,
  confidence: Provenance["confidence"],
): WithProvenance<T> {
  return { value, provenance: { source, confidence } };
}

/**
 * Assign a numeric provenance-wrapped value onto `target[key]` only when the
 * value is present and finite.  Collapses the repeated
 * `x !== undefined && Number.isFinite(x)` guards on the conditions fields.
 * Behaviour is identical to the inline blocks (same wp()/provenance semantics).
 */
function assignFinite<K extends keyof Signals>(
  target: Signals,
  key: K,
  value: number | undefined,
  source: Source,
  confidence: Provenance["confidence"],
): void {
  if (value !== undefined && Number.isFinite(value)) {
    target[key] = wp(value, source, confidence) as Signals[K];
  }
}

/**
 * Derive calendar season from the SWEDISH month.
 * Northern hemisphere: Dec-Feb=winter, Mar-May=spring, Jun-Aug=summer, Sep-Nov=autumn.
 *
 * Uses the Europe/Stockholm month, not the host-local or UTC month: on a UTC
 * server a month boundary near midnight would otherwise land in the wrong
 * season (e.g. 00:30 CET on 1 Mar is still 23:30 UTC on 28 Feb → "winter").
 */
function seasonFromDate(date: Date): Season {
  const month = stockholmParts(date).month - 1; // 0-11, Swedish local
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

/**
 * Emit a source_miss event (fire-and-forget — never throws).
 *
 * M5: `reason` distinguishes a thrown failure ("error", the default from
 * safe()) from the common graceful-absence cases ("empty" / "no_row") so
 * observability no longer under-reports missing signals.
 */
function missFire(
  lakeId: string,
  source: string,
  reason: "error" | "empty" | "no_row" = "error",
): void {
  // L-b1: emit() is contractually non-throwing (it catches its own insert
  // failures internally), so no extra .catch() wrapper is needed — just fire
  // and forget.
  void emit({ type: "source_miss", lakeId, payload: { source, reason } });
}

/** Safely run an async producer; returns the result or undefined on any error. */
async function safe<T>(
  fn: () => Promise<T>,
  onMiss: () => void,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    // L: log at debug level so a real code bug is distinguishable from
    // legitimate "data unavailable" — without losing the never-throws contract
    // (we still call onMiss() and return undefined).
    console.error("[signals] source producer failed (treated as miss):", err);
    onMiss();
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────────────

export async function buildSignals(input: BuildSignalsInput): Promise<Signals> {
  const { lake, targetTime, now } = input;
  // C1 (defense in depth): guard against Invalid Date.  ask-handler already
  // validates the date before calling us, but we must never throw here
  // (ADR-0002 never-throws contract).  If targetTime is Invalid Date,
  // fall back to `now` so toISOString() cannot throw a RangeError.
  const safeTargetTime = !Number.isNaN(targetTime.getTime()) ? targetTime : now;
  const targetUtc = safeTargetTime.toISOString();

  // ── Step 1: Conditions (forecast OR observed) ─────────────────────────────

  type ConditionsResult = {
    air_temperature?: number;
    air_pressure_at_mean_sea_level?: number;
    wind_speed?: number;
    wind_from_direction?: number;
    cloud_area_fraction?: number;
    precipitation_amount_mean?: number;
    wind_speed_of_gust?: number;
    thunderstorm_probability?: number;
    visibility_in_air?: number;
    /**
     * snapDeltaMinutes: on the forecast branch, the forecast snap delta (M1);
     * on the observed branch, how far the nearest obs is from target (#8).
     */
    snapDeltaMinutes?: number;
    /** M1: observed station distance in km (set on the observed branch). */
    stationDistanceKm?: number;
  };

  let source: "forecast" | "observed";
  try {
    source = conditionsSource(targetUtc, now);
  } catch {
    missFire(lake.id, "conditions_source");
    source = "forecast";
  }

  // H5: run the independent fetch groups concurrently instead of serially.
  //   Group A: conditions  +  the two metobs trends (each via its station).
  //   Group B: the water DB lookups depth / colour / species.
  //   waterTemp depends on the air-temp trend, so it stays ordered AFTER the
  //   trend group (see Step 2b below).
  // Each branch keeps its own safe() wrapper so the never-throws contract
  // (ADR-0002) holds.

  // M5: resolve the nearest TEMP station ONCE and share it. Both the observed-
  // conditions branch and the air-temp trend need it; the in-process cache in
  // nearestStation doesn't help because in a single Promise.all both fire
  // before either populates it — so without sharing we'd do two identical
  // station scans + haversine sweeps per build. A single shared promise also
  // exposes the station distanceKm to the conditions confidence flag (M1).
  const tempStationPromise = safe(
    () => nearestStation(lake, "temp"),
    () => missFire(lake.id, "nearestStation.temp"),
  );

  const conditionsPromise = safe<ConditionsResult>(
    async () => {
      if (source === "forecast") {
        const doc = await getForecast(lake.id, lake.lat, lake.lon);
        const { params, snapDeltaMinutes } = pickEntry(doc, targetUtc);
        // M1: surface the forecast snap delta so the assemble step can mark
        // point conditions low-confidence when the nearest entry is far off.
        return { ...params, snapDeltaMinutes };
      }
      // observed — reuse the shared temp station (M5)
      const tempStation = await tempStationPromise;
      if (!tempStation) {
        // No station available — treat as missing
        throw new Error("no temp station for observed conditions");
      }
      const observed = await observedConditions(
        tempStation.station.id,
        targetUtc,
      );
      // M1: surface the observed station distance so the assemble step can mark
      // point conditions low-confidence when the station is far from the lake.
      return { ...observed, stationDistanceKm: tempStation.distanceKm };
    },
    () => missFire(lake.id, "conditions"),
  );

  // ── Step 2: metobs trends (station → trend) for pressure and temp ──────────
  // Run concurrently with conditions and with the water-DB group below.
  const pressureTrendPromise = (async () => {
    const station = await safe(
      () => nearestStation(lake, "pressure"),
      () => missFire(lake.id, "nearestStation.pressure"),
    );
    if (!station) return undefined;
    return safe(
      () => pressureTrend24h(station.station.id),
      () => missFire(lake.id, "pressureTrend"),
    );
  })();

  const airTempTrendPromise = (async () => {
    // M5: reuse the shared temp station instead of a second nearestStation call.
    const station = await tempStationPromise;
    if (!station) return undefined;
    return safe(
      () => airTempTrend5d(station.station.id, station.distanceKm),
      () => missFire(lake.id, "airTempTrend"),
    );
  })();

  // ── Step 3: water DB lookups (independent — run concurrently) ──────────────
  const depthPromise = safe(
    () => depthFor(lake.id),
    () => missFire(lake.id, "depth"),
  );
  const colourPromise = safe(
    () => colourFor(lake.id),
    () => missFire(lake.id, "colour"),
  );
  const speciesPromise = safe(
    () => speciesFor(lake.id),
    () => missFire(lake.id, "species"),
  );

  // Await the concurrent groups.
  const [
    conditions,
    pressureTrend,
    airTempTrend,
    depthResult,
    colourResult,
    speciesResult,
  ] = await Promise.all([
    conditionsPromise,
    pressureTrendPromise,
    airTempTrendPromise,
    depthPromise,
    colourPromise,
    speciesPromise,
  ]);

  // M1: derive the point-conditions confidence honestly instead of hardcoding
  // "high". Forecast: a large snap delta (the nearest entry is far from the
  // target time) → low. Observed: a far station (> 40 km, the metobs
  // tempConfidence threshold) → low. Per CONTEXT.md Provenance, this lets the
  // LLM hedge just as the trend path already does.
  const FORECAST_SNAP_LOW_MINUTES = 90;
  let conditionsConfidence: Provenance["confidence"] = "high";
  if (
    source === "forecast" &&
    conditions?.snapDeltaMinutes !== undefined &&
    conditions.snapDeltaMinutes > FORECAST_SNAP_LOW_MINUTES
  ) {
    conditionsConfidence = "low";
  } else if (
    source === "observed" &&
    conditions?.stationDistanceKm !== undefined
  ) {
    conditionsConfidence = tempConfidence(conditions.stationDistanceKm);
  }

  // #8: observed-data staleness. On the observed (past-target) path the nearest
  // available observation can be far from the requested TIME (distinct from M1's
  // station DISTANCE) — outside "latest-day" it may be many hours off with no
  // marker. When the offset exceeds the threshold, surface it on the Signals so
  // the LLM can hedge, and additionally force the conditions confidence to low
  // (staleness compounds any station-distance downgrade M1 already applied). The
  // forecast path is unaffected.
  const OBS_STALE_THRESHOLD_MIN = 180; // 3 h — beyond this the snapshot is "stale"
  const conditionsStaleMinutes =
    source === "observed" &&
    conditions?.snapDeltaMinutes !== undefined &&
    conditions.snapDeltaMinutes > OBS_STALE_THRESHOLD_MIN
      ? conditions.snapDeltaMinutes
      : undefined;
  if (conditionsStaleMinutes !== undefined) {
    conditionsConfidence = "low";
  }

  let pressureTrendSignal: Signals["pressureTrend"];
  if (pressureTrend !== undefined) {
    pressureTrendSignal = wp(pressureTrend, "observed", "high");
  }

  let airTempTrendSignal: Signals["airTempTrend5d"];
  let airTempTrendValue: AirTempTrend | undefined;
  if (airTempTrend !== undefined) {
    airTempTrendValue = airTempTrend.trend;
    airTempTrendSignal = wp(
      airTempTrend.trend,
      "observed",
      airTempTrend.confidence,
    );
  }

  // ── Step 4: Water temp (depends on the air-temp trend — kept ordered) ──────

  const season = seasonFromDate(safeTargetTime);
  const waterTemp = await safe(
    () =>
      waterTempFor(lake.id, {
        season,
        airTempTrend5d: airTempTrendValue,
        areaHa: lake.areaHa,
      }),
    () => missFire(lake.id, "waterTemp"),
  );

  // ── Step 5: Derived signals ───────────────────────────────────────────────

  // Light window (pure — guarded because sunTimes/lightWindow can throw on edge inputs)
  let light: Signals["lightWindow"];
  try {
    const sun = sunTimes(lake.lat, lake.lon, safeTargetTime);
    light = lightWindow(safeTargetTime, sun);
  } catch {
    missFire(lake.id, "light_window");
    // light remains undefined → lightWindow signal is omitted below
  }

  // Windward shore — only if wind direction is available.
  // M4: wrapped in try/catch like light_window — windwardShore now throws on
  // non-finite input (M6), and a throw here must not abort the whole build
  // after the sources succeeded (ADR-0002 never-throws contract).
  let windwardShoreSignal: Signals["windwardShore"];
  let windDirectionSignal: Signals["windDirection"];
  const windDir = conditions?.wind_from_direction;
  if (windDir !== undefined && Number.isFinite(windDir)) {
    try {
      // M1/#8: windward shore is derived from the wind reading, so it inherits
      // the same point-conditions confidence (station-distance M1 + staleness #8)
      // rather than a hardcoded "high".
      windwardShoreSignal = wp(
        windwardShore(windDir),
        source,
        conditionsConfidence,
      );
      windDirectionSignal = wp(
        describeWindDirection(windDir),
        source,
        conditionsConfidence,
      );
    } catch {
      missFire(lake.id, "windward_shore");
    }
  }

  // Species comfort — only when BOTH waterTemp AND species are present.
  // M4: wrapped in try/catch so a throw in speciesComfort cannot abort the
  // build after sources succeeded.
  let speciesComfortSignal: Signals["speciesComfort"];
  if (
    waterTemp !== undefined &&
    speciesResult !== null &&
    speciesResult !== undefined &&
    speciesResult.length > 0
  ) {
    try {
      const comfortResult = speciesComfort(speciesResult, waterTemp.value);
      if (Object.keys(comfortResult).length > 0) {
        speciesComfortSignal = comfortResult;
      }
    } catch {
      missFire(lake.id, "species_comfort");
    }
  }

  // ── Assemble Signals ──────────────────────────────────────────────────────

  const signals: Signals = {
    lake: lake.label,
    lakeId: lake.id,
    // I1: store the bare lake name alongside the formatted label so the
    // lake-lock comparison in follow-ups can compare against the bare name
    // rather than the full "name (municipality, county)" label.
    bareLakeName: lake.name,
    // Europe/Stockholm wall-clock (zone-less ISO) — this field is what the LLM
    // reads as "the time the angler is standing in". `.toISOString()` would
    // render UTC (22:00 for a 00:00-Stockholm summer instant) → wrong hour.
    timeLocal: formatStockholmLocal(safeTargetTime),
  };

  // #8: flag observed staleness so the LLM can hedge on the observed snapshot.
  if (conditionsStaleMinutes !== undefined) {
    signals.conditionsStaleMinutes = conditionsStaleMinutes;
  }

  // Conditions fields (M1: confidence derived from snap-delta / station distance;
  // #8: additionally downgraded when the observed snapshot is stale).
  assignFinite(
    signals,
    "airTempC",
    conditions?.air_temperature,
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "pressureHpa",
    conditions?.air_pressure_at_mean_sea_level,
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "windMs",
    conditions?.wind_speed,
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "cloudPct",
    // SMHI delivers octas (0–8) — cloudPct is percent (see octasToPercent).
    octasToPercent(conditions?.cloud_area_fraction),
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "precipMmH",
    conditions?.precipitation_amount_mean,
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "windGustMs",
    conditions?.wind_speed_of_gust,
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "thunderPct",
    // Negative SMHI sentinels become absent, not a -9 in the snapshot.
    probabilityPct(conditions?.thunderstorm_probability),
    source,
    conditionsConfidence,
  );
  assignFinite(
    signals,
    "visibilityKm",
    conditions?.visibility_in_air,
    source,
    conditionsConfidence,
  );

  // Trends
  if (pressureTrendSignal) signals.pressureTrend = pressureTrendSignal;
  if (airTempTrendSignal) signals.airTempTrend5d = airTempTrendSignal;

  // Water temp
  if (waterTemp !== undefined) signals.waterTempC = waterTemp;

  // Depth.  M5: depthFor returning null (no row) is the common graceful-absence
  // case and previously emitted nothing — emit source_miss(reason:"no_row").
  if (
    depthResult !== undefined &&
    depthResult !== null &&
    depthResult.maxDepthM !== null
  ) {
    signals.maxDepthM = wp(depthResult.maxDepthM, "modeled", "high");
  } else if (depthResult === null) {
    missFire(lake.id, "depth", "no_row");
  }

  // Colour.  M5: null result (no MVM row) now emits source_miss(no_row).
  if (colourResult !== undefined && colourResult !== null) {
    signals.waterColour = wp(
      colourResult.colour,
      "modeled",
      colourResult.confidence,
    );
    if (
      colourResult.sightDepthM !== null &&
      Number.isFinite(colourResult.sightDepthM)
    ) {
      signals.sightDepthM = wp(
        colourResult.sightDepthM,
        "modeled",
        colourResult.confidence,
      );
    }
  } else if (colourResult === null) {
    missFire(lake.id, "colour", "no_row");
  }

  // Species.  M5: null (no survey row) or empty array now emits source_miss.
  if (
    speciesResult !== undefined &&
    speciesResult !== null &&
    speciesResult.length > 0
  ) {
    signals.speciesPresent = speciesResult;
  } else if (speciesResult === null) {
    missFire(lake.id, "species", "no_row");
  } else if (Array.isArray(speciesResult) && speciesResult.length === 0) {
    missFire(lake.id, "species", "empty");
  }

  // Derived
  if (light !== undefined) signals.lightWindow = light;
  if (windwardShoreSignal) signals.windwardShore = windwardShoreSignal;
  if (windDirectionSignal) signals.windDirection = windDirectionSignal;
  if (speciesComfortSignal) signals.speciesComfort = speciesComfortSignal;

  // ── Analytics ─────────────────────────────────────────────────────────────

  // L-b1: emit() never rejects (see missFire) — fire and forget.
  void emit({ type: "signals_built", lakeId: lake.id });

  return signals;
}
