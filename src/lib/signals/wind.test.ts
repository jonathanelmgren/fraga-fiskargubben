import { describe, expect, it } from "vitest";
import { windwardShore } from "./wind";

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
});
