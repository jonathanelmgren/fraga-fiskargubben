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
} from "@/lib/weather/metobs";
import { lightWindow, sunTimes } from "./light";
import { speciesComfort } from "./species-comfort";
import type { Provenance, Signals, Source, WithProvenance } from "./types";
import { windwardShore } from "./wind";

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
 * Derive calendar season from the LOCAL month (0-indexed).
 * Northern hemisphere: Dec-Feb=winter, Mar-May=spring, Jun-Aug=summer, Sep-Nov=autumn.
 *
 * L4: uses getMonth() (local) rather than getUTCMonth() so it stays consistent
 * with the rest of the file's local-time handling — at UTC+1/+2 a month-
 * boundary near midnight would otherwise land in the wrong season.
 */
function seasonFromDate(date: Date): Season {
  const month = date.getMonth(); // 0-11, local
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
  void Promise.resolve(
    emit({ type: "source_miss", lakeId, payload: { source, reason } }),
  ).catch(() => {
    // analytics failures are always swallowed
  });
}

/** Safely run an async producer; returns the result or undefined on any error. */
async function safe<T>(
  fn: () => Promise<T>,
  onMiss: () => void,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
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

  const conditionsPromise = safe<ConditionsResult>(
    async () => {
      if (source === "forecast") {
        const doc = await getForecast(lake.id, lake.lat, lake.lon);
        const { params } = pickEntry(doc, targetUtc);
        return params;
      }
      // observed — need a temp station to find the nearest station
      const tempStation = await nearestStation(lake, "temp");
      if (!tempStation) {
        // No station available — treat as missing
        throw new Error("no temp station for observed conditions");
      }
      return observedConditions(tempStation.station.id, targetUtc);
    },
    () => missFire(lake.id, "conditions"),
  );

  // Trend chain (station → trend) for pressure and temp, run concurrently with
  // conditions and with the water-DB group below.
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
    const station = await safe(
      () => nearestStation(lake, "temp"),
      () => missFire(lake.id, "nearestStation.temp"),
    );
    if (!station) return undefined;
    return safe(
      () => airTempTrend5d(station.station.id, station.distanceKm),
      () => missFire(lake.id, "airTempTrend"),
    );
  })();

  // ── Step: water DB lookups (independent — run concurrently) ────────────────
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

  // ── Step 2b: Water temp (depends on the air-temp trend — kept ordered) ─────

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

  // ── Step 7: Derived signals ───────────────────────────────────────────────

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
  const windDir = conditions?.wind_from_direction;
  if (windDir !== undefined && Number.isFinite(windDir)) {
    try {
      windwardShoreSignal = wp(windwardShore(windDir), source, "high");
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
    timeLocal: safeTargetTime.toISOString(),
  };

  // Conditions fields
  if (
    conditions?.air_temperature !== undefined &&
    Number.isFinite(conditions.air_temperature)
  ) {
    signals.airTempC = wp(conditions.air_temperature, source, "high");
  }
  if (
    conditions?.air_pressure_at_mean_sea_level !== undefined &&
    Number.isFinite(conditions.air_pressure_at_mean_sea_level)
  ) {
    signals.pressureHpa = wp(
      conditions.air_pressure_at_mean_sea_level,
      source,
      "high",
    );
  }
  if (
    conditions?.wind_speed !== undefined &&
    Number.isFinite(conditions.wind_speed)
  ) {
    signals.windMs = wp(conditions.wind_speed, source, "high");
  }
  if (
    conditions?.cloud_area_fraction !== undefined &&
    Number.isFinite(conditions.cloud_area_fraction)
  ) {
    signals.cloudPct = wp(conditions.cloud_area_fraction, source, "high");
  }

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
  if (speciesComfortSignal) signals.speciesComfort = speciesComfortSignal;

  // ── Analytics ─────────────────────────────────────────────────────────────

  void Promise.resolve(emit({ type: "signals_built", lakeId: lake.id })).catch(
    () => {
      // analytics failures are swallowed
    },
  );

  return signals;
}
