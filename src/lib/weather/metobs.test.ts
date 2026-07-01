// vi.mock calls are hoisted — these always run, even before imports.
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/env", () => ({
  env: {
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://localhost/fiskargubben",
    ANTHROPIC_API_KEY: "test",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-chars!!",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "test",
    GOOGLE_CLIENT_SECRET: "test",
    MICROSOFT_CLIENT_ID: "test",
    MICROSOFT_CLIENT_SECRET: "test",
  },
}));

import { describe, expect, it } from "vitest";
import {
  pressureObsFixture,
  tempObsFixture,
  windDirObsFixture,
  windSpeedObsFixture,
} from "./__fixtures__/metobs-conditions-fixture";
import {
  classifyPressureTrend,
  classifyTempTrend,
  conditionsSource,
  mapObsToConditions,
  type RawObsSet,
  tempConfidence,
} from "./metobs";

// ─────────────────────────────────────────────────────────────────────────────
// classifyPressureTrend — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyPressureTrend", () => {
  it("returns 'stable' when delta is exactly 0", () => {
    expect(classifyPressureTrend(0)).toBe("stable");
  });

  it("returns 'stable' when delta is within threshold (< 1.5 hPa)", () => {
    expect(classifyPressureTrend(1.4)).toBe("stable");
    expect(classifyPressureTrend(-1.4)).toBe("stable");
  });

  it("returns 'stable' when delta is exactly at threshold boundary (1.5 hPa exclusive)", () => {
    // |Δ| < 1.5 → stable; 1.5 itself is NOT stable
    expect(classifyPressureTrend(1.49)).toBe("stable");
    expect(classifyPressureTrend(-1.49)).toBe("stable");
  });

  it("returns 'rising' when delta >= 1.5 hPa", () => {
    expect(classifyPressureTrend(1.5)).toBe("rising");
    expect(classifyPressureTrend(3.0)).toBe("rising");
    expect(classifyPressureTrend(10.0)).toBe("rising");
  });

  it("returns 'falling' when delta <= -1.5 hPa", () => {
    expect(classifyPressureTrend(-1.5)).toBe("falling");
    expect(classifyPressureTrend(-3.0)).toBe("falling");
    expect(classifyPressureTrend(-10.0)).toBe("falling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyTempTrend — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyTempTrend", () => {
  it("returns 'steady' when delta is exactly 0", () => {
    expect(classifyTempTrend(0)).toBe("steady");
  });

  it("returns 'steady' when delta is within threshold (< 2 °C)", () => {
    expect(classifyTempTrend(1.9)).toBe("steady");
    expect(classifyTempTrend(-1.9)).toBe("steady");
  });

  it("returns 'steady' when delta is just below threshold boundary", () => {
    expect(classifyTempTrend(1.99)).toBe("steady");
    expect(classifyTempTrend(-1.99)).toBe("steady");
  });

  it("returns 'warming' when delta >= 2 °C", () => {
    expect(classifyTempTrend(2.0)).toBe("warming");
    expect(classifyTempTrend(5.0)).toBe("warming");
    expect(classifyTempTrend(15.0)).toBe("warming");
  });

  it("returns 'cooling' when delta <= -2 °C", () => {
    expect(classifyTempTrend(-2.0)).toBe("cooling");
    expect(classifyTempTrend(-5.0)).toBe("cooling");
    expect(classifyTempTrend(-15.0)).toBe("cooling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tempConfidence — pure unit tests (ADR-0002, spec §3 >40 km → low)
// ─────────────────────────────────────────────────────────────────────────────

describe("tempConfidence", () => {
  it("returns 'high' when distance is 0 km", () => {
    expect(tempConfidence(0)).toBe("high");
  });

  it("returns 'high' when distance is well under 40 km", () => {
    expect(tempConfidence(10)).toBe("high");
    expect(tempConfidence(25)).toBe("high");
    expect(tempConfidence(39.9)).toBe("high");
  });

  it("returns 'high' when distance is exactly 40 km (boundary: ≤ 40 is high)", () => {
    expect(tempConfidence(40)).toBe("high");
  });

  it("returns 'low' when distance is just over 40 km", () => {
    expect(tempConfidence(40.1)).toBe("low");
  });

  it("returns 'low' when distance is well over 40 km", () => {
    expect(tempConfidence(60)).toBe("low");
    expect(tempConfidence(200)).toBe("low");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// conditionsSource — pure unit tests (ADR-0002 dual-source switch)
//
// Boundary decision: targetTimeUtc strictly BEFORE `now` → "observed".
// targetTimeUtc equal to or after `now` → "forecast".
// Rationale: "now" is never truly in the past — observations may lag by minutes,
// so we conservatively use the forecast for the current moment.
// ─────────────────────────────────────────────────────────────────────────────

describe("conditionsSource", () => {
  const now = new Date("2024-06-15T12:00:00Z");

  it("returns 'observed' for a clearly past time", () => {
    expect(conditionsSource("2024-06-14T12:00:00Z", now)).toBe("observed");
  });

  it("returns 'observed' for a time 1 ms before now", () => {
    const justBefore = new Date(now.getTime() - 1).toISOString();
    expect(conditionsSource(justBefore, now)).toBe("observed");
  });

  it("returns 'forecast' for a time exactly equal to now (boundary: now → forecast)", () => {
    expect(conditionsSource(now.toISOString(), now)).toBe("forecast");
  });

  it("returns 'forecast' for a time 1 ms after now", () => {
    const justAfter = new Date(now.getTime() + 1).toISOString();
    expect(conditionsSource(justAfter, now)).toBe("forecast");
  });

  it("returns 'forecast' for a clearly future time", () => {
    expect(conditionsSource("2024-06-16T12:00:00Z", now)).toBe("forecast");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapObsToConditions — pure mapper, fixture-tested (no network)
// ─────────────────────────────────────────────────────────────────────────────

describe("mapObsToConditions", () => {
  const targetTimeUtc = "2024-06-15T12:00:00Z"; // epoch 1718452800000 — last fixture entry

  const obsSet: RawObsSet = {
    temp: tempObsFixture.value,
    pressure: pressureObsFixture.value,
    windSpeed: windSpeedObsFixture.value,
    windDir: windDirObsFixture.value,
  };

  it("picks the temp observation nearest to the target time", () => {
    const result = mapObsToConditions(obsSet, targetTimeUtc);
    expect(result.air_temperature).toBe(16.1);
  });

  it("picks the pressure observation nearest to the target time", () => {
    const result = mapObsToConditions(obsSet, targetTimeUtc);
    expect(result.air_pressure_at_mean_sea_level).toBe(1012.0);
  });

  it("picks the wind_speed observation nearest to the target time", () => {
    const result = mapObsToConditions(obsSet, targetTimeUtc);
    expect(result.wind_speed).toBe(4.1);
  });

  it("picks the wind_from_direction observation nearest to the target time", () => {
    const result = mapObsToConditions(obsSet, targetTimeUtc);
    expect(result.wind_from_direction).toBe(260);
  });

  it("marks every field with source: 'observed'", () => {
    const result = mapObsToConditions(obsSet, targetTimeUtc);
    expect(result.source).toBe("observed");
  });

  it("returns undefined fields when the obs array is empty for that parameter", () => {
    const sparse: RawObsSet = {
      temp: [],
      pressure: pressureObsFixture.value,
      windSpeed: [],
      windDir: [],
    };
    const result = mapObsToConditions(sparse, targetTimeUtc);
    expect(result.air_temperature).toBeUndefined();
    expect(result.air_pressure_at_mean_sea_level).toBe(1012.0);
    expect(result.wind_speed).toBeUndefined();
    expect(result.wind_from_direction).toBeUndefined();
    expect(result.source).toBe("observed");
  });

  it("picks earlier entry when equidistant (first wins tie-break)", () => {
    // Target at 10:30 is equidistant from 10:00 and 11:00
    const result = mapObsToConditions(obsSet, "2024-06-15T10:30:00Z");
    // 10:00 entry (epoch 1718445600000) and 11:00 entry (1718449200000)
    // 10:30 is 1800000 ms from both; first wins
    expect(result.air_temperature).toBe(14.7);
  });

  // #8: staleness offset (snapDeltaMinutes) — the largest offset across params.
  it("reports snapDeltaMinutes ≈ 0 when target is inside the obs window", () => {
    // Target 12:00 matches the last fixture entry exactly for every param.
    const result = mapObsToConditions(obsSet, targetTimeUtc);
    expect(result.snapDeltaMinutes).toBe(0);
  });

  it("reports the largest offset (minutes) when target is far from the obs", () => {
    // Target one full day before the window → nearest obs is the 10:00 entry,
    // 26 h earlier (1560 min) for every param; max across params is the same.
    const result = mapObsToConditions(obsSet, "2024-06-14T08:00:00Z");
    // 2024-06-15T10:00Z − 2024-06-14T08:00Z = 26 h = 1560 min
    expect(result.snapDeltaMinutes).toBe(1560);
  });

  it("takes the MAX offset across params, not the min", () => {
    // temp has an entry AT the target; pressure's nearest is 2 h away.
    const mixed: RawObsSet = {
      temp: [{ date: new Date("2024-06-15T12:00:00Z").getTime(), value: "16" }],
      pressure: [
        { date: new Date("2024-06-15T10:00:00Z").getTime(), value: "1010" },
      ],
      windSpeed: [],
      windDir: [],
    };
    const result = mapObsToConditions(mixed, targetTimeUtc);
    // temp offset 0, pressure offset 120 min → max = 120
    expect(result.snapDeltaMinutes).toBe(120);
  });

  it("leaves snapDeltaMinutes undefined when no param has data", () => {
    const empty: RawObsSet = {
      temp: [],
      pressure: [],
      windSpeed: [],
      windDir: [],
    };
    const result = mapObsToConditions(empty, targetTimeUtc);
    expect(result.snapDeltaMinutes).toBeUndefined();
  });
});
