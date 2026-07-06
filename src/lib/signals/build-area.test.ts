/**
 * Tests for buildAreaSignals — all source modules mocked, no network/DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weather/forecast", () => ({
  getForecast: vi.fn(),
  pickEntry: vi.fn(),
}));

vi.mock("@/lib/weather/metobs", () => ({
  conditionsSource: vi.fn(),
  nearestStation: vi.fn(),
  observedConditions: vi.fn(),
  pressureTrend24h: vi.fn(),
  airTempTrend5d: vi.fn(),
  tempConfidence: (distanceKm: number): "high" | "low" =>
    distanceKm > 40 ? "low" : "high",
}));

vi.mock("@/lib/analytics/events", () => ({
  emit: vi.fn(),
}));

vi.mock("@/lib/signals/light", () => ({
  sunTimes: vi.fn(),
  lightWindow: vi.fn(),
}));

import { emit } from "@/lib/analytics/events";
import { lightWindow, sunTimes } from "@/lib/signals/light";
import { getForecast, pickEntry } from "@/lib/weather/forecast";
import {
  airTempTrend5d,
  conditionsSource,
  nearestStation,
  pressureTrend24h,
} from "@/lib/weather/metobs";
import { buildAreaSignals } from "./build-area";

const NOW = new Date("2026-07-03T10:00:00Z");
const TARGET = new Date("2026-07-03T17:00:00Z");

function happyMocks() {
  vi.mocked(conditionsSource).mockReturnValue("forecast");
  vi.mocked(getForecast).mockResolvedValue({} as never);
  vi.mocked(pickEntry).mockReturnValue({
    params: {
      air_temperature: 18.2,
      air_pressure_at_mean_sea_level: 1013,
      wind_speed: 5.5,
      wind_from_direction: 240,
      cloud_area_fraction: 6, // octas — becomes cloudPct 75 (%)
      precipitation_amount_mean: 0.4,
      wind_speed_of_gust: 11.2,
      thunderstorm_probability: -9, // SMHI negative sentinel → absent
      visibility_in_air: 18.5,
    },
    snapDeltaMinutes: 15,
  } as never);
  vi.mocked(nearestStation).mockResolvedValue({
    station: { id: "12345", name: "Station", lat: 57.8, lon: 13.4 },
    distanceKm: 12,
  } as never);
  vi.mocked(pressureTrend24h).mockResolvedValue("falling" as never);
  vi.mocked(airTempTrend5d).mockResolvedValue({
    trend: "warming",
    confidence: "high",
  } as never);
  vi.mocked(sunTimes).mockReturnValue({} as never);
  vi.mocked(lightWindow).mockReturnValue("dusk" as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAreaSignals", () => {
  it("builds a reduced area snapshot with SMHI conditions only", async () => {
    happyMocks();
    const signals = await buildAreaSignals({
      label: "trakten kring Ulricehamn",
      lat: 57.79,
      lon: 13.42,
      askedLakeName: "Gösputten",
      targetTime: TARGET,
      now: NOW,
    });

    expect(signals.lake).toBe("trakten kring Ulricehamn");
    expect(signals.lakeId).toBe("area");
    expect(signals.areaOnly).toBe(true);
    expect(signals.askedLakeName).toBe("Gösputten");
    expect(signals.airTempC?.value).toBe(18.2);
    expect(signals.windMs?.value).toBe(5.5);
    expect(signals.cloudPct?.value).toBe(75);
    expect(signals.precipMmH?.value).toBe(0.4);
    expect(signals.windGustMs?.value).toBe(11.2);
    expect(signals.thunderPct).toBeUndefined();
    expect(signals.visibilityKm?.value).toBe(18.5);
    expect(signals.pressureTrend?.value).toBe("falling");
    expect(signals.airTempTrend5d?.value).toBe("warming");
    expect(signals.lightWindow).toBe("dusk");
    expect(signals.windwardShore).toBeDefined();
    // wind_from_direction 240 (WSW) → drift toward ENE
    expect(signals.windDirection?.value).toEqual({
      fromDeg: 240,
      fromCompass: "WSW",
      towardDeg: 60,
      towardCompass: "ENE",
    });

    // No lake-specific fields.
    expect(signals.waterTempC).toBeUndefined();
    expect(signals.maxDepthM).toBeUndefined();
    expect(signals.speciesPresent).toBeUndefined();
    expect(signals.waterColour).toBeUndefined();
    expect(signals.bareLakeName).toBeUndefined();
  });

  it("uses an area-cell forecast cache key", async () => {
    happyMocks();
    await buildAreaSignals({
      label: "trakten",
      lat: 57.789,
      lon: 13.421,
      targetTime: TARGET,
      now: NOW,
    });
    expect(vi.mocked(getForecast)).toHaveBeenCalledWith(
      "area:57.79,13.42",
      57.789,
      13.421,
    );
  });

  it("never throws when every source fails — minimal honest snapshot", async () => {
    vi.mocked(conditionsSource).mockImplementation(() => {
      throw new Error("boom");
    });
    vi.mocked(getForecast).mockRejectedValue(new Error("smhi down"));
    vi.mocked(nearestStation).mockRejectedValue(new Error("db down"));
    vi.mocked(sunTimes).mockImplementation(() => {
      throw new Error("bad coords");
    });

    const signals = await buildAreaSignals({
      label: "trakten",
      lat: 57.79,
      lon: 13.42,
      targetTime: TARGET,
      now: NOW,
    });

    expect(signals.areaOnly).toBe(true);
    expect(signals.airTempC).toBeUndefined();
    expect(signals.lightWindow).toBeUndefined();
    // misses were emitted
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "source_miss" }),
    );
  });

  it("emits signals_built", async () => {
    happyMocks();
    await buildAreaSignals({
      label: "trakten",
      lat: 57.79,
      lon: 13.42,
      targetTime: TARGET,
      now: NOW,
    });
    expect(vi.mocked(emit)).toHaveBeenCalledWith({
      type: "signals_built",
      lakeId: "area",
    });
  });
});
