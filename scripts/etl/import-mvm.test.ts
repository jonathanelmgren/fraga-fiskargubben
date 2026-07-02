import { describe, expect, it } from "vitest";
import { sweref99ToWgs84 } from "@/lib/geo/sweref99";
import fixture from "./__fixtures__/mvm-chemistry-sample.json";
import {
  absToPerMetre,
  adaptMvmStation,
  extractMvmSample,
  type MvmRawChemistrySample,
  mapMvmSample,
} from "./import-mvm";

// Fixture mirrors the REAL MVM v2 bulk chemistry sample shape, verified live
// 2026-07-02: FLAT (station info + observations inline), stationEUID →
// lakes.id, stationCoordinateN/E in SWEREF99 TM, absorbans420 unit "/5cm",
// observation values are decimal-comma strings.
const SAMPLE = fixture.sample as MvmRawChemistrySample;

describe("absToPerMetre", () => {
  it("multiplies a /5cm absorbance by 20 to get per-metre", () => {
    expect(absToPerMetre(0.123, "/5cm")).toBeCloseTo(2.46);
  });
  it("passes a per-metre value through unchanged", () => {
    expect(absToPerMetre(2.46, "/m")).toBeCloseTo(2.46);
    expect(absToPerMetre(2.46, "abs/m")).toBeCloseTo(2.46);
  });
  it("normalises other explicit path lengths generically", () => {
    // /50mm is also a 5 cm path → ×20.
    expect(absToPerMetre(0.123, "/50mm")).toBeCloseTo(2.46);
    // /10cm → ×10.
    expect(absToPerMetre(0.2, "/10cm")).toBeCloseTo(2.0);
  });
});

describe("extractMvmSample", () => {
  it("extracts the EUID and converts absorbans420 /5cm → /m (0,123 → 2.46)", () => {
    const s = extractMvmSample(SAMPLE);
    expect(s.stationId).toBe("SE639339-154122");
    expect(s.samplingDate).toBe("2009-01-12");
    expect(s.absorbans420).toBeCloseTo(2.46);
  });
});

describe("adaptMvmStation", () => {
  it("reprojects SWEREF99 TM coordinates to WGS84 and carries the EUID", () => {
    const station = adaptMvmStation(SAMPLE);
    expect(station).not.toBeNull();
    if (!station) return;
    // 6392208 / 589249 SWEREF99 TM → ~57.66 N, ~16.50 E (Kalmar län).
    const expected = sweref99ToWgs84(6392208, 589249);
    expect(expected).not.toBeNull();
    expect(station.lat).toBeCloseTo(57.66, 1);
    expect(station.lon).toBeCloseTo(16.5, 1);
    expect(station.lat).toBeCloseTo(expected?.lat ?? 0);
    expect(station.lon).toBeCloseTo(expected?.lon ?? 0);
    expect(station.euCd).toBe("SE639339-154122");
    expect(station.stationId).toBe("SE639339-154122");
  });

  it("returns null when coordinates are absent", () => {
    expect(
      adaptMvmStation({ stationEUID: "SEx", stationCoordinateN: null }),
    ).toBeNull();
  });
});

describe("mapMvmSample (colour classification)", () => {
  it("classifies the fixture's high absorbance as brown", () => {
    const s = extractMvmSample(SAMPLE); // absorbans420 ≈ 2.46 m⁻¹ (>> 0.1)
    const row = mapMvmSample(s, "SE639339-154122", "high");
    expect(row.colour).toBe("brown");
    expect(row.confidence).toBe("high");
    expect(row.lakeId).toBe("SE639339-154122");
  });

  it("classifies a low absorbance as clear", () => {
    const row = mapMvmSample(
      { stationId: "x", absorbans420: 0.05 },
      "SEx",
      "high",
    );
    expect(row.colour).toBe("clear");
  });

  it("regression: without the ×20 conversion a /5cm value would misclassify", () => {
    // 0.123 read as per-metre is ≤ 0.1? No — 0.123 > 0.1 already brown here, so
    // assert the CONVERTED value is what feeds the row (2.46, not 0.123).
    const s = extractMvmSample(SAMPLE);
    expect(s.absorbans420).not.toBeCloseTo(0.123);
    expect(s.absorbans420).toBeCloseTo(2.46);
  });

  it("throws when neither colour indicator is present", () => {
    expect(() => mapMvmSample({ stationId: "x" }, "SEx", "low")).toThrow();
  });
});
