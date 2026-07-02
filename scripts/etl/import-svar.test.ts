import { describe, expect, it } from "vitest";
import {
  mapWaterToLake,
  parseVissNumber,
  pickLatLong,
  type VissLookups,
  type VissWater,
} from "./import-svar";

// Fixtures mirror the REAL VISS API response shapes, verified live 2026-07-02:
//   waters: EU_CD, Name, SurfaceAreaKM2, Municipalites[], Coordinates[]
//   Coordinates carry SWEREF99 / RT90 / LatLong; LatLong is WGS84 with a
//   decimal COMMA and XValue=lat, YValue=lon.

const LOOKUPS: VissLookups = {
  municipality: new Map([
    ["1490", { name: "Lidköping", countyCode: "14" }],
    ["0180", { name: "Stockholm", countyCode: "01" }],
    // A municipality whose county has no name entry → county falls back.
    ["9999", { name: "Gränskommun", countyCode: "ZZ" }],
  ]),
  county: new Map([
    ["14", "Västra Götalands län"],
    ["01", "Stockholms län"],
  ]),
};

const WATER: VissWater = {
  EU_CD: "SE656250-138625",
  Name: "Vänern",
  SurfaceAreaKM2: 5648.6,
  Municipalites: ["1490"],
  Coordinates: [
    { XValue: "6497000", YValue: "384000", Format: "SWEREF99" },
    { XValue: "6501000", YValue: "1384000", Format: "RT90" },
    { XValue: "58,7554", YValue: "13,2489", Format: "LatLong" },
  ],
};

describe("parseVissNumber", () => {
  it("parses a decimal-comma string", () => {
    expect(parseVissNumber("62,168353608048")).toBeCloseTo(62.168353608048);
  });
  it("returns NaN for null/undefined", () => {
    expect(Number.isNaN(parseVissNumber(null))).toBe(true);
    expect(Number.isNaN(parseVissNumber(undefined))).toBe(true);
  });
});

describe("pickLatLong", () => {
  it("picks the LatLong (WGS84) entry, XValue=lat / YValue=lon", () => {
    expect(pickLatLong(WATER.Coordinates)).toEqual({
      lat: 58.7554,
      lon: 13.2489,
    });
  });
  it("returns null when there is no LatLong format", () => {
    expect(
      pickLatLong([{ XValue: "1", YValue: "2", Format: "SWEREF99" }]),
    ).toBeNull();
  });
  it("returns null for empty / missing coordinates", () => {
    expect(pickLatLong([])).toBeNull();
    expect(pickLatLong(null)).toBeNull();
  });
});

describe("mapWaterToLake", () => {
  it("maps a full VISS water to a lake row (km² → ha, resolved names)", () => {
    const row = mapWaterToLake(WATER, LOOKUPS);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.id).toBe("SE656250-138625");
    expect(row.name).toBe("Vänern");
    expect(row.municipality).toBe("Lidköping");
    expect(row.county).toBe("Västra Götalands län");
    expect(row.lat).toBeCloseTo(58.7554);
    expect(row.lon).toBeCloseTo(13.2489);
    expect(row.areaHa).toBeCloseTo(564_860); // 5648.6 km² × 100
  });

  it("sets name to null when Name is absent or blank", () => {
    expect(
      mapWaterToLake({ ...WATER, Name: undefined }, LOOKUPS)?.name,
    ).toBeNull();
    expect(mapWaterToLake({ ...WATER, Name: "  " }, LOOKUPS)?.name).toBeNull();
  });

  it("falls back to Okänd when municipality code is unresolved", () => {
    const row = mapWaterToLake({ ...WATER, Municipalites: ["0000"] }, LOOKUPS);
    expect(row?.municipality).toBe("Okänd");
    expect(row?.county).toBe("Okänd");
  });

  it("falls back to Okänd county when the county code has no name", () => {
    const row = mapWaterToLake({ ...WATER, Municipalites: ["9999"] }, LOOKUPS);
    expect(row?.municipality).toBe("Gränskommun");
    expect(row?.county).toBe("Okänd");
  });

  it("skips (null) when EU_CD is missing", () => {
    expect(mapWaterToLake({ ...WATER, EU_CD: undefined }, LOOKUPS)).toBeNull();
  });

  it("skips (null) when there is no LatLong centroid", () => {
    const noLatLong = {
      ...WATER,
      Coordinates: [{ XValue: "1", YValue: "2", Format: "SWEREF99" }],
    };
    expect(mapWaterToLake(noLatLong, LOOKUPS)).toBeNull();
  });

  it("skips (null) when area is missing", () => {
    expect(
      mapWaterToLake({ ...WATER, SurfaceAreaKM2: null }, LOOKUPS),
    ).toBeNull();
  });
});
