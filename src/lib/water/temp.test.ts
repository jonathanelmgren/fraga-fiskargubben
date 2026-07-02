import { describe, expect, it } from "vitest";
import { estimateWaterTemp, type WaterTempInput } from "./temp";

// ────────────────────────────────────────────────────────────────────────────
// estimateWaterTemp — pure formula tests
// ────────────────────────────────────────────────────────────────────────────

describe("estimateWaterTemp", () => {
  const summerBase: WaterTempInput = {
    season: "summer",
    airTempTrend5d: "steady",
    areaHa: 500,
  };
  const winterBase: WaterTempInput = {
    season: "winter",
    airTempTrend5d: "steady",
    areaHa: 500,
  };

  it("returns a finite celsius value in a sane range [0, 30]", () => {
    const result = estimateWaterTemp(summerBase);
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.value).toBeGreaterThanOrEqual(0);
    expect(result.value).toBeLessThanOrEqual(30);
  });

  it("summer is warmer than winter for the same other inputs", () => {
    const summer = estimateWaterTemp(summerBase);
    const winter = estimateWaterTemp(winterBase);
    expect(summer.value).toBeGreaterThan(winter.value);
  });

  it("warming trend nudges value up vs steady for the same season", () => {
    const warming = estimateWaterTemp({
      ...summerBase,
      airTempTrend5d: "warming",
    });
    const steady = estimateWaterTemp(summerBase); // steady
    expect(warming.value).toBeGreaterThan(steady.value);
  });

  it("cooling trend nudges value down vs steady for the same season", () => {
    const cooling = estimateWaterTemp({
      ...summerBase,
      airTempTrend5d: "cooling",
    });
    const steady = estimateWaterTemp(summerBase);
    expect(cooling.value).toBeLessThan(steady.value);
  });

  it("small lake (< 50 ha) is more responsive than large lake to warming trend", () => {
    const smallWarm = estimateWaterTemp({
      season: "summer",
      airTempTrend5d: "warming",
      areaHa: 10,
    });
    const largeWarm = estimateWaterTemp({
      season: "summer",
      airTempTrend5d: "warming",
      areaHa: 5000,
    });
    // Small lake warms more, so warming nudge effect is larger
    const smallSteady = estimateWaterTemp({
      season: "summer",
      airTempTrend5d: "steady",
      areaHa: 10,
    });
    const largeSteady = estimateWaterTemp({
      season: "summer",
      airTempTrend5d: "steady",
      areaHa: 5000,
    });
    expect(smallWarm.value - smallSteady.value).toBeGreaterThan(
      largeWarm.value - largeSteady.value,
    );
  });

  it("provenance is {source: estimated, confidence: low}", () => {
    const result = estimateWaterTemp(summerBase);
    expect(result.provenance.source).toBe("estimated");
    expect(result.provenance.confidence).toBe("low");
  });

  it("is deterministic — same inputs always yield the same value", () => {
    const a = estimateWaterTemp(summerBase);
    const b = estimateWaterTemp(summerBase);
    expect(a.value).toBe(b.value);
  });

  it("works without optional fields", () => {
    const result = estimateWaterTemp({ season: "spring" });
    expect(Number.isFinite(result.value)).toBe(true);
    expect(result.provenance.source).toBe("estimated");
  });

  it("spring is between winter and summer", () => {
    const spring = estimateWaterTemp({
      season: "spring",
      airTempTrend5d: "steady",
    });
    const winter = estimateWaterTemp({
      season: "winter",
      airTempTrend5d: "steady",
    });
    const summer = estimateWaterTemp({
      season: "summer",
      airTempTrend5d: "steady",
    });
    expect(spring.value).toBeGreaterThan(winter.value);
    expect(spring.value).toBeLessThan(summer.value);
  });

  it("autumn is between winter and summer", () => {
    const autumn = estimateWaterTemp({
      season: "autumn",
      airTempTrend5d: "steady",
    });
    const winter = estimateWaterTemp({
      season: "winter",
      airTempTrend5d: "steady",
    });
    const summer = estimateWaterTemp({
      season: "summer",
      airTempTrend5d: "steady",
    });
    expect(autumn.value).toBeGreaterThan(winter.value);
    expect(autumn.value).toBeLessThan(summer.value);
  });
});
