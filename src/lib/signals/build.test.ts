/**
 * Integration tests for buildSignals orchestrator.
 * All source modules are mocked — no real network/DB calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WithProvenance } from "./types";

// ── Mock all source modules ──────────────────────────────────────────────────

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
}));

vi.mock("@/lib/water/temp", () => ({
  waterTempFor: vi.fn(),
}));

vi.mock("@/lib/water/depth", () => ({
  depthFor: vi.fn(),
}));

vi.mock("@/lib/water/colour", () => ({
  colourFor: vi.fn(),
}));

vi.mock("@/lib/water/species", () => ({
  speciesFor: vi.fn(),
}));

vi.mock("@/lib/analytics/events", () => ({
  emit: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { emit } from "@/lib/analytics/events";
import { colourFor } from "@/lib/water/colour";
import { depthFor } from "@/lib/water/depth";
import { speciesFor } from "@/lib/water/species";
import { waterTempFor } from "@/lib/water/temp";
import { getForecast, pickEntry } from "@/lib/weather/forecast";
import {
  airTempTrend5d,
  conditionsSource,
  nearestStation,
  observedConditions,
  pressureTrend24h,
} from "@/lib/weather/metobs";

import { buildSignals } from "./build";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const LAKE = {
  id: "test-lake",
  name: "Test Lake",
  label: "Testsjön",
  lat: 59.3,
  lon: 18.1,
  areaHa: 120,
};

// A future time → forecast path
const FUTURE_TARGET = new Date("2026-07-15T10:00:00Z");
// A past time → observed path
const PAST_TARGET = new Date("2026-07-14T10:00:00Z");
// "now" for tests
const NOW = new Date("2026-07-15T08:00:00Z");

const FORECAST_DOC = {
  geometry: { type: "Point", coordinates: [18.1, 59.3] as [number, number] },
  timeSeries: [
    {
      time: "2026-07-15T10:00:00Z",
      data: {
        air_temperature: 18,
        air_pressure_at_mean_sea_level: 1013,
        wind_speed: 4,
        wind_from_direction: 270, // W → windward shore E
        cloud_area_fraction: 50,
      },
    },
  ],
};

const PICK_RESULT = {
  entry: FORECAST_DOC.timeSeries[0],
  snapDeltaMinutes: 0,
  params: {
    air_temperature: 18,
    air_pressure_at_mean_sea_level: 1013,
    wind_speed: 4,
    wind_from_direction: 270,
    cloud_area_fraction: 50,
  },
};

const NEAREST_PRESSURE_STATION = {
  station: {
    id: "s1",
    name: "S1",
    lat: 59.3,
    lon: 18.0,
    parameter: "pressure",
  },
  distanceKm: 15,
};
const NEAREST_TEMP_STATION = {
  station: { id: "s2", name: "S2", lat: 59.2, lon: 18.1, parameter: "temp" },
  distanceKm: 20,
};

const WATER_TEMP_WITH_PROV: WithProvenance<number> = {
  value: 17,
  provenance: { source: "estimated", confidence: "low" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupForecastOnly() {
  vi.mocked(conditionsSource).mockReturnValue("forecast");
  vi.mocked(getForecast).mockResolvedValue(FORECAST_DOC);
  vi.mocked(pickEntry).mockReturnValue(PICK_RESULT);
  vi.mocked(nearestStation).mockImplementation((_lake, param) =>
    Promise.resolve(
      param === "pressure" ? NEAREST_PRESSURE_STATION : NEAREST_TEMP_STATION,
    ),
  );
  vi.mocked(pressureTrend24h).mockResolvedValue("stable");
  vi.mocked(airTempTrend5d).mockResolvedValue({
    trend: "steady",
    confidence: "high",
  });
  vi.mocked(waterTempFor).mockResolvedValue(WATER_TEMP_WITH_PROV);
  // Water sources absent
  vi.mocked(depthFor).mockResolvedValue(null);
  vi.mocked(colourFor).mockResolvedValue(null);
  vi.mocked(speciesFor).mockResolvedValue(null);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildSignals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("forecast-only lake", () => {
    it("returns a valid Signals with lake/lakeId/timeLocal always present", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.lake).toBe(LAKE.label);
      expect(signals.lakeId).toBe(LAKE.id);
      expect(signals.timeLocal).toBeDefined();
      expect(typeof signals.timeLocal).toBe("string");
    });

    it("assembles conditions from forecast", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.airTempC).toEqual({
        value: 18,
        provenance: { source: "forecast", confidence: "high" },
      });
      expect(signals.pressureHpa).toEqual({
        value: 1013,
        provenance: { source: "forecast", confidence: "high" },
      });
      expect(signals.windMs).toEqual({
        value: 4,
        provenance: { source: "forecast", confidence: "high" },
      });
      expect(signals.cloudPct).toEqual({
        value: 50,
        provenance: { source: "forecast", confidence: "high" },
      });
    });

    it("derives windwardShore from wind_from_direction", async () => {
      setupForecastOnly(); // wind_from_direction = 270 (W) → windward shore = E

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.windwardShore).toBeDefined();
      expect(signals.windwardShore?.value).toBe("E");
      expect(signals.windwardShore?.provenance.source).toBe("forecast");
    });

    it("includes lightWindow", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.lightWindow).toBeDefined();
      expect(["dawn", "day", "dusk", "night"]).toContain(signals.lightWindow);
    });

    it("omits waterColour/sightDepthM/maxDepthM/speciesPresent when absent", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.waterColour).toBeUndefined();
      expect(signals.sightDepthM).toBeUndefined();
      expect(signals.maxDepthM).toBeUndefined();
      expect(signals.speciesPresent).toBeUndefined();
      expect(signals.speciesComfort).toBeUndefined();
    });

    it("emits signals_built analytics event", async () => {
      setupForecastOnly();

      await buildSignals({ lake: LAKE, targetTime: FUTURE_TARGET, now: NOW });

      expect(vi.mocked(emit)).toHaveBeenCalledWith(
        expect.objectContaining({ type: "signals_built", lakeId: LAKE.id }),
      );
    });
  });

  describe("speciesComfort gating", () => {
    it("includes speciesComfort when BOTH waterTemp and species present", async () => {
      setupForecastOnly();
      vi.mocked(speciesFor).mockResolvedValue(["gädda", "abborre"]);
      // waterTempFor already returns WATER_TEMP_WITH_PROV (17°C)

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.speciesPresent).toEqual(["gädda", "abborre"]);
      expect(signals.speciesComfort).toBeDefined();
      expect(signals.speciesComfort?.gädda).toBe("comfortable"); // 17°C < 21
      expect(signals.speciesComfort?.abborre).toBe("comfortable"); // 17°C < 24
    });

    it("omits speciesComfort when species absent (even though waterTemp present)", async () => {
      setupForecastOnly();
      vi.mocked(speciesFor).mockResolvedValue(null);

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.speciesPresent).toBeUndefined();
      expect(signals.speciesComfort).toBeUndefined();
    });

    it("omits speciesComfort when waterTemp absent (even though species present)", async () => {
      setupForecastOnly();
      vi.mocked(speciesFor).mockResolvedValue(["gädda"]);
      vi.mocked(waterTempFor).mockRejectedValue(new Error("db down"));

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.speciesComfort).toBeUndefined();
    });
  });

  describe("graceful degradation — source throws → omit + source_miss", () => {
    it("does not throw when depthFor rejects", async () => {
      setupForecastOnly();
      vi.mocked(depthFor).mockRejectedValue(new Error("db timeout"));

      await expect(
        buildSignals({ lake: LAKE, targetTime: FUTURE_TARGET, now: NOW }),
      ).resolves.toBeDefined();
    });

    it("emits source_miss when depthFor throws", async () => {
      setupForecastOnly();
      vi.mocked(depthFor).mockRejectedValue(new Error("db timeout"));

      await buildSignals({ lake: LAKE, targetTime: FUTURE_TARGET, now: NOW });

      expect(vi.mocked(emit)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "source_miss",
          payload: expect.objectContaining({ source: "depth" }),
        }),
      );
    });

    it("omits maxDepthM when depthFor throws", async () => {
      setupForecastOnly();
      vi.mocked(depthFor).mockRejectedValue(new Error("db timeout"));

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.maxDepthM).toBeUndefined();
    });

    it("does not throw when getForecast rejects (forecast path)", async () => {
      setupForecastOnly();
      vi.mocked(getForecast).mockRejectedValue(new Error("SMHI down"));

      await expect(
        buildSignals({ lake: LAKE, targetTime: FUTURE_TARGET, now: NOW }),
      ).resolves.toBeDefined();
    });

    it("emits source_miss for conditions when forecast fetch fails", async () => {
      setupForecastOnly();
      vi.mocked(getForecast).mockRejectedValue(new Error("SMHI down"));

      await buildSignals({ lake: LAKE, targetTime: FUTURE_TARGET, now: NOW });

      expect(vi.mocked(emit)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "source_miss",
          payload: expect.objectContaining({ source: "conditions" }),
        }),
      );
    });

    it("omits airTempC/pressureHpa etc when forecast fails", async () => {
      setupForecastOnly();
      vi.mocked(getForecast).mockRejectedValue(new Error("SMHI down"));

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.airTempC).toBeUndefined();
      expect(signals.pressureHpa).toBeUndefined();
      expect(signals.windMs).toBeUndefined();
    });
  });

  describe("conditionsSource — past vs future picks observed vs forecast", () => {
    it("calls observedConditions for past targetTime", async () => {
      vi.mocked(conditionsSource).mockReturnValue("observed");
      vi.mocked(nearestStation).mockImplementation((_lake, param) =>
        Promise.resolve(
          param === "pressure"
            ? NEAREST_PRESSURE_STATION
            : NEAREST_TEMP_STATION,
        ),
      );
      vi.mocked(observedConditions).mockResolvedValue({
        air_temperature: 15,
        air_pressure_at_mean_sea_level: 1010,
        wind_speed: 3,
        wind_from_direction: 90,
        source: "observed",
      });
      vi.mocked(pressureTrend24h).mockResolvedValue("falling");
      vi.mocked(airTempTrend5d).mockResolvedValue({
        trend: "cooling",
        confidence: "high",
      });
      vi.mocked(waterTempFor).mockResolvedValue(WATER_TEMP_WITH_PROV);
      vi.mocked(depthFor).mockResolvedValue(null);
      vi.mocked(colourFor).mockResolvedValue(null);
      vi.mocked(speciesFor).mockResolvedValue(null);

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: PAST_TARGET,
        now: NOW,
      });

      expect(vi.mocked(observedConditions)).toHaveBeenCalled();
      expect(vi.mocked(getForecast)).not.toHaveBeenCalled();
      expect(signals.airTempC?.provenance.source).toBe("observed");
    });

    it("calls getForecast for future targetTime", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(vi.mocked(getForecast)).toHaveBeenCalled();
      expect(vi.mocked(observedConditions)).not.toHaveBeenCalled();
      expect(signals.airTempC?.provenance.source).toBe("forecast");
    });
  });

  describe("provenance", () => {
    it("forecast conditions carry source=forecast", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.airTempC?.provenance.source).toBe("forecast");
      expect(signals.pressureHpa?.provenance.source).toBe("forecast");
    });

    it("estimated water temp carries source=estimated", async () => {
      setupForecastOnly();

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.waterTempC?.provenance.source).toBe("estimated");
      expect(signals.waterTempC?.provenance.confidence).toBe("low");
    });

    it("waterColour carries provenance from colourFor", async () => {
      setupForecastOnly();
      vi.mocked(colourFor).mockResolvedValue({
        colour: "brown",
        sightDepthM: 1.5,
        confidence: "high",
      });

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.waterColour?.value).toBe("brown");
      expect(signals.waterColour?.provenance.source).toBe("modeled");
      expect(signals.waterColour?.provenance.confidence).toBe("high");
      expect(signals.sightDepthM?.value).toBe(1.5);
    });

    it("maxDepthM carries modeled/high provenance when depthFor returns a value", async () => {
      setupForecastOnly();
      vi.mocked(depthFor).mockResolvedValue({ maxDepthM: 32, meanDepthM: 12 });

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.maxDepthM?.value).toBe(32);
      expect(signals.maxDepthM?.provenance.source).toBe("modeled");
      expect(signals.maxDepthM?.provenance.confidence).toBe("high");
    });
  });

  describe("trends", () => {
    it("includes pressureTrend and airTempTrend5d from metobs", async () => {
      setupForecastOnly();
      vi.mocked(pressureTrend24h).mockResolvedValue("rising");
      vi.mocked(airTempTrend5d).mockResolvedValue({
        trend: "warming",
        confidence: "low",
      });

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.pressureTrend?.value).toBe("rising");
      expect(signals.airTempTrend5d?.value).toBe("warming");
      expect(signals.airTempTrend5d?.provenance.confidence).toBe("low");
    });

    it("omits pressureTrend when nearestStation(pressure) returns null", async () => {
      setupForecastOnly();
      vi.mocked(nearestStation).mockImplementation((_lake, param) =>
        Promise.resolve(param === "pressure" ? null : NEAREST_TEMP_STATION),
      );

      const signals = await buildSignals({
        lake: LAKE,
        targetTime: FUTURE_TARGET,
        now: NOW,
      });

      expect(signals.pressureTrend).toBeUndefined();
    });
  });
});
