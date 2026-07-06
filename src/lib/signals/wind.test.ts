import { describe, expect, it } from "vitest";
import { describeWindDirection, windwardShore } from "./wind";

describe("windwardShore", () => {
  // Test the 8 cardinal and intercardinal directions
  it("0° (N wind from north) → S shore", () => {
    expect(windwardShore(0)).toBe("S");
  });

  it("45° (NE wind from northeast) → SW shore", () => {
    expect(windwardShore(45)).toBe("SW");
  });

  it("90° (E wind from east) → W shore", () => {
    expect(windwardShore(90)).toBe("W");
  });

  it("135° (SE wind from southeast) → NW shore", () => {
    expect(windwardShore(135)).toBe("NW");
  });

  it("180° (S wind from south) → N shore", () => {
    expect(windwardShore(180)).toBe("N");
  });

  it("225° (SW wind from southwest) → NE shore", () => {
    expect(windwardShore(225)).toBe("NE");
  });

  it("270° (W wind from west) → E shore", () => {
    expect(windwardShore(270)).toBe("E");
  });

  it("315° (NW wind from northwest) → SE shore", () => {
    expect(windwardShore(315)).toBe("SE");
  });

  // Test binning boundaries (just inside each cardinal/intercardinal bin)
  it("binning: 1° just past N bin start → N", () => {
    expect(windwardShore(1)).toBe("S");
  });

  it("binning: 22.5° exactly at NE bin start → NE", () => {
    expect(windwardShore(202.5)).toBe("NE");
  });

  it("binning: 112.5° exactly at SE bin start → SE", () => {
    expect(windwardShore(292.5)).toBe("SE");
  });

  // Test normalization of negative values
  it("normalization: -90° (equivalent to 270°) → E shore", () => {
    expect(windwardShore(-90)).toBe("E");
  });

  it("normalization: -180° (equivalent to 180°) → N shore", () => {
    expect(windwardShore(-180)).toBe("N");
  });

  // Test normalization of values >= 360
  it("normalization: 450° (equivalent to 90°) → W shore", () => {
    expect(windwardShore(450)).toBe("W");
  });

  it("normalization: 360° (equivalent to 0°) → S shore", () => {
    expect(windwardShore(360)).toBe("S");
  });

  it("normalization: 720° (equivalent to 0°) → S shore", () => {
    expect(windwardShore(720)).toBe("S");
  });

  // M6: non-finite input must throw rather than silently returning "N"
  it("throws on NaN input (no confident-wrong fallback)", () => {
    expect(() => windwardShore(Number.NaN)).toThrow();
  });

  it("throws on Infinity input", () => {
    expect(() => windwardShore(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("describeWindDirection", () => {
  it("270° (wind from W) → toward E at 90°", () => {
    expect(describeWindDirection(270)).toEqual({
      fromDeg: 270,
      fromCompass: "W",
      towardDeg: 90,
      towardCompass: "E",
    });
  });

  // The nuance case that motivated 16-point labels: almost-SW westerly wind
  // should read as drift toward the northeast-leaning part of the east shore.
  it("240° (wind from WSW) → toward ENE at 60°", () => {
    expect(describeWindDirection(240)).toEqual({
      fromDeg: 240,
      fromCompass: "WSW",
      towardDeg: 60,
      towardCompass: "ENE",
    });
  });

  it("0° (wind from N) → toward S at 180°", () => {
    expect(describeWindDirection(0)).toEqual({
      fromDeg: 0,
      fromCompass: "N",
      towardDeg: 180,
      towardCompass: "S",
    });
  });

  // 16-point bin boundaries: bins are 22.5° wide, centered on each point.
  it("11.24° still N, 11.25° flips to NNE", () => {
    expect(describeWindDirection(11.24).fromCompass).toBe("N");
    expect(describeWindDirection(11.25).fromCompass).toBe("NNE");
  });

  it("348.75° flips back to N (wraparound bin)", () => {
    expect(describeWindDirection(348.75).fromCompass).toBe("N");
    expect(describeWindDirection(348.74).fromCompass).toBe("NNW");
  });

  it("normalizes negative input: -90° ≡ 270°", () => {
    expect(describeWindDirection(-90)).toEqual(describeWindDirection(270));
  });

  it("normalizes over-360 input: 450° ≡ 90°", () => {
    expect(describeWindDirection(450)).toEqual(describeWindDirection(90));
  });

  it("throws on NaN input (no confident-wrong fallback)", () => {
    expect(() => describeWindDirection(Number.NaN)).toThrow();
  });

  it("throws on Infinity input", () => {
    expect(() => describeWindDirection(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("agrees with windwardShore on exact cardinals/intercardinals", () => {
    for (const [deg, shore] of [
      [0, "S"],
      [45, "SW"],
      [90, "W"],
      [135, "NW"],
      [180, "N"],
      [225, "NE"],
      [270, "E"],
      [315, "SE"],
    ] as const) {
      expect(describeWindDirection(deg).towardCompass).toBe(shore);
      expect(windwardShore(deg)).toBe(shore);
    }
  });
});
