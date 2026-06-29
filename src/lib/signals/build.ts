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
 * Derive calendar season from UTC month (0-indexed).
 * Northern hemisphere: Dec-Feb=winter, Mar-May=spring, Jun-Aug=summer, Sep-Nov=autumn.
 */
function seasonFromDate(date: Date): Season {
  const month = date.getUTCMonth(); // 0-11
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

/** Emit a source_miss event (fire-and-forget — never throws). */
function missFire(lakeId: string, source: string): void {
  void Promise.resolve(
    emit({ type: "source_miss", lakeId, payload: { source } }),
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
  const targetUtc = targetTime.toISOString();

  // ── Step 1: Conditions (forecast OR observed) ─────────────────────────────

  type ConditionsResult = {
    air_temperature?: number;
    air_pressure_at_mean_sea_level?: number;
    wind_speed?: number;
    wind_from_direction?: number;
    cloud_area_fraction?: number;
  };

  const source = conditionsSource(targetUtc, now);

  const conditions = await safe<ConditionsResult>(
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

  // ── Step 2: Trends ────────────────────────────────────────────────────────

  const [pressureStationResult, tempStationResult] = await Promise.all([
    safe(
      () => nearestStation(lake, "pressure"),
      () => missFire(lake.id, "nearestStation.pressure"),
    ),
    safe(
      () => nearestStation(lake, "temp"),
      () => missFire(lake.id, "nearestStation.temp"),
    ),
  ]);

  let pressureTrendSignal: Signals["pressureTrend"];
  if (pressureStationResult) {
    const trend = await safe(
      () => pressureTrend24h(pressureStationResult.station.id),
      () => missFire(lake.id, "pressureTrend"),
    );
    if (trend !== undefined) {
      pressureTrendSignal = wp(trend, "observed", "high");
    }
  }

  let airTempTrendSignal: Signals["airTempTrend5d"];
  let airTempTrendValue: AirTempTrend | undefined;
  if (tempStationResult) {
    const trendResult = await safe(
      () =>
        airTempTrend5d(
          tempStationResult.station.id,
          tempStationResult.distanceKm,
        ),
      () => missFire(lake.id, "airTempTrend"),
    );
    if (trendResult !== undefined) {
      airTempTrendValue = trendResult.trend;
      airTempTrendSignal = wp(
        trendResult.trend,
        "observed",
        trendResult.confidence,
      );
    }
  }

  // ── Step 3: Water temp ────────────────────────────────────────────────────

  const season = seasonFromDate(targetTime);
  const waterTemp = await safe(
    () =>
      waterTempFor(lake.id, {
        season,
        airTempTrend5d: airTempTrendValue,
        areaHa: lake.areaHa,
      }),
    () => missFire(lake.id, "waterTemp"),
  );

  // ── Step 4: Depth ─────────────────────────────────────────────────────────

  const depthResult = await safe(
    () => depthFor(lake.id),
    () => missFire(lake.id, "depth"),
  );

  // ── Step 5: Colour / sight depth ──────────────────────────────────────────

  const colourResult = await safe(
    () => colourFor(lake.id),
    () => missFire(lake.id, "colour"),
  );

  // ── Step 6: Species ───────────────────────────────────────────────────────

  const speciesResult = await safe(
    () => speciesFor(lake.id),
    () => missFire(lake.id, "species"),
  );

  // ── Step 7: Derived signals ───────────────────────────────────────────────

  // Light window (pure — always succeeds if sunTimes does)
  const sun = sunTimes(lake.lat, lake.lon, targetTime);
  const light = lightWindow(targetTime, sun);

  // Windward shore — only if wind direction is available
  let windwardShoreSignal: Signals["windwardShore"];
  const windDir = conditions?.wind_from_direction;
  if (windDir !== undefined && Number.isFinite(windDir)) {
    windwardShoreSignal = wp(windwardShore(windDir), source, "high");
  }

  // Species comfort — only when BOTH waterTemp AND species are present
  let speciesComfortSignal: Signals["speciesComfort"];
  if (
    waterTemp !== undefined &&
    speciesResult !== null &&
    speciesResult !== undefined &&
    speciesResult.length > 0
  ) {
    speciesComfortSignal = speciesComfort(speciesResult, waterTemp.value);
  }

  // ── Assemble Signals ──────────────────────────────────────────────────────

  const signals: Signals = {
    lake: lake.label,
    lakeId: lake.id,
    timeLocal: targetTime.toISOString(),
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

  // Depth
  if (
    depthResult !== undefined &&
    depthResult !== null &&
    depthResult.maxDepthM !== null
  ) {
    signals.maxDepthM = wp(depthResult.maxDepthM, "modeled", "high");
  }

  // Colour
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
  }

  // Species
  if (speciesResult !== undefined && speciesResult !== null) {
    signals.speciesPresent = speciesResult;
  }

  // Derived
  signals.lightWindow = light;
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
