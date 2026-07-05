/**
 * buildAreaSignals — reduced Signals for unresolved-area conversations.
 *
 * When lake resolution gives up (rebuild spec), the conversation continues on
 * SMHI data for the area coordinates only: point conditions (forecast or
 * observed), pressure/temp trends, and the light window. Lake-specific data
 * (water temp, depth, colour, species) is deliberately absent — the gubbe is
 * honest about not knowing the specific water, but the wind still blows.
 *
 * Same never-throws contract as buildSignals (ADR-0002): a failing source
 * emits `source_miss` and the field is simply absent.
 */

import { emit } from "@/lib/analytics/events";
import { formatStockholmLocal } from "@/lib/time/stockholm";
import { getForecast, pickEntry } from "@/lib/weather/forecast";
import {
  airTempTrend5d,
  conditionsSource,
  nearestStation,
  observedConditions,
  pressureTrend24h,
  tempConfidence,
} from "@/lib/weather/metobs";
import { lightWindow, sunTimes } from "./light";
import type { Provenance, Signals, Source, WithProvenance } from "./types";
import { windwardShore } from "./wind";

export interface BuildAreaSignalsInput {
  /** Area label the LLM reads, e.g. `trakten kring Ulricehamn`. */
  label: string;
  lat: number;
  lon: number;
  /** The lake name the user asked about (for honest "don't know it" answers). */
  askedLakeName?: string;
  /** Nearest named lakes (user-location mode) — see Signals.nearbyLakes. */
  nearbyLakes?: Signals["nearbyLakes"];
  targetTime: Date;
  now: Date;
}

/** Synthetic lakeId marker for area snapshots + the forecast cache key prefix. */
export const AREA_LAKE_ID = "area";

function wp<T>(
  value: T,
  source: Source,
  confidence: Provenance["confidence"],
): WithProvenance<T> {
  return { value, provenance: { source, confidence } };
}

function missFire(source: string): void {
  void emit({ type: "source_miss", lakeId: AREA_LAKE_ID, payload: { source } });
}

async function safe<T>(
  fn: () => Promise<T>,
  onMiss: () => void,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      "[signals:area] source producer failed (treated as miss):",
      err,
    );
    onMiss();
    return undefined;
  }
}

export async function buildAreaSignals(
  input: BuildAreaSignalsInput,
): Promise<Signals> {
  const { label, lat, lon, askedLakeName, nearbyLakes, targetTime, now } =
    input;
  const safeTargetTime = !Number.isNaN(targetTime.getTime()) ? targetTime : now;
  const targetUtc = safeTargetTime.toISOString();

  // Cache the SMHI doc per ~1km cell so nearby area conversations share it.
  const cacheKey = `${AREA_LAKE_ID}:${lat.toFixed(2)},${lon.toFixed(2)}`;

  let source: "forecast" | "observed";
  try {
    source = conditionsSource(targetUtc, now);
  } catch {
    missFire("conditions_source");
    source = "forecast";
  }

  const point = { lat, lon };

  const tempStationPromise = safe(
    () => nearestStation(point, "temp"),
    () => missFire("nearestStation.temp"),
  );

  type ConditionsResult = {
    air_temperature?: number;
    air_pressure_at_mean_sea_level?: number;
    wind_speed?: number;
    wind_from_direction?: number;
    cloud_area_fraction?: number;
    snapDeltaMinutes?: number;
    stationDistanceKm?: number;
  };

  const conditionsPromise = safe<ConditionsResult>(
    async () => {
      if (source === "forecast") {
        const doc = await getForecast(cacheKey, lat, lon);
        const { params, snapDeltaMinutes } = pickEntry(doc, targetUtc);
        return { ...params, snapDeltaMinutes };
      }
      const tempStation = await tempStationPromise;
      if (!tempStation) {
        throw new Error("no temp station for observed area conditions");
      }
      const observed = await observedConditions(
        tempStation.station.id,
        targetUtc,
      );
      return { ...observed, stationDistanceKm: tempStation.distanceKm };
    },
    () => missFire("conditions"),
  );

  const pressureTrendPromise = (async () => {
    const station = await safe(
      () => nearestStation(point, "pressure"),
      () => missFire("nearestStation.pressure"),
    );
    if (!station) return undefined;
    return safe(
      () => pressureTrend24h(station.station.id),
      () => missFire("pressureTrend"),
    );
  })();

  const airTempTrendPromise = (async () => {
    const station = await tempStationPromise;
    if (!station) return undefined;
    return safe(
      () => airTempTrend5d(station.station.id, station.distanceKm),
      () => missFire("airTempTrend"),
    );
  })();

  const [conditions, pressureTrend, airTempTrend] = await Promise.all([
    conditionsPromise,
    pressureTrendPromise,
    airTempTrendPromise,
  ]);

  // Same confidence derivation as buildSignals (M1/#8).
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

  const signals: Signals = {
    lake: label,
    lakeId: AREA_LAKE_ID,
    areaOnly: true,
    timeLocal: formatStockholmLocal(safeTargetTime),
  };
  if (askedLakeName) signals.askedLakeName = askedLakeName;
  if (nearbyLakes && nearbyLakes.length > 0) signals.nearbyLakes = nearbyLakes;

  const assign = (
    key: "airTempC" | "pressureHpa" | "windMs" | "cloudPct",
    value: number | undefined,
  ) => {
    if (value !== undefined && Number.isFinite(value)) {
      signals[key] = wp(value, source, conditionsConfidence);
    }
  };
  assign("airTempC", conditions?.air_temperature);
  assign("pressureHpa", conditions?.air_pressure_at_mean_sea_level);
  assign("windMs", conditions?.wind_speed);
  assign("cloudPct", conditions?.cloud_area_fraction);

  if (pressureTrend !== undefined) {
    signals.pressureTrend = wp(pressureTrend, "observed", "high");
  }
  if (airTempTrend !== undefined) {
    signals.airTempTrend5d = wp(
      airTempTrend.trend,
      "observed",
      airTempTrend.confidence,
    );
  }

  const windDir = conditions?.wind_from_direction;
  if (windDir !== undefined && Number.isFinite(windDir)) {
    try {
      signals.windwardShore = wp(
        windwardShore(windDir),
        source,
        conditionsConfidence,
      );
    } catch {
      missFire("windward_shore");
    }
  }

  try {
    const sun = sunTimes(lat, lon, safeTargetTime);
    signals.lightWindow = lightWindow(safeTargetTime, sun);
  } catch {
    missFire("light_window");
  }

  void emit({ type: "signals_built", lakeId: AREA_LAKE_ID });

  return signals;
}
