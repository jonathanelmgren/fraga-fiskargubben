import { describe, expect, it } from "vitest";
import { mapFeatureToLake } from "./import-svar";

// Fixture: a representative SVAR WFS feature as returned by SMHI Vattenwebb.
// Property names are assumed from the SVAR GeoJSON/WFS schema documentation.
// See scripts/etl/README.md for full field-name assumptions.
const FIXTURE_FEATURE = {
  type: "Feature" as const,
  id: "MS_WB_AREA.12345",
  geometry: null,
  properties: {
    MS_CD: "SE656250-138625", // SVAR water body identifier (EU WFD code)
    MS_NAME: "Vänern",
    KOMMUNNAMN: "Västra Götalands kommuner",
    LANNAMN: "Västra Götalands län",
    CENTROID_N: 658_930.5, // stored as-is; CRS must be WGS84/CRS84 at WFS-request level
    CENTROID_E: 327_120.3, // stored as-is; see scripts/etl/README.md for CRS note
    AREA_HA: 593_380.0,
  },
};

describe("mapFeatureToLake", () => {
  it("maps a full SVAR feature to a lake row", () => {
    const row = mapFeatureToLake(FIXTURE_FEATURE);

    expect(row.id).toBe("SE656250-138625");
    expect(row.name).toBe("Vänern");
    expect(row.municipality).toBe("Västra Götalands kommuner");
    expect(row.county).toBe("Västra Götalands län");
    expect(row.areaHa).toBe(593_380.0);

    // Centroid stored as provided (numeric; SWEREF99 or WGS84 depending on dataset)
    expect(row.lat).toBe(658_930.5);
    expect(row.lon).toBe(327_120.3);
  });

  it("sets name to null when MS_NAME is absent", () => {
    const feature = {
      ...FIXTURE_FEATURE,
      properties: { ...FIXTURE_FEATURE.properties, MS_NAME: undefined },
    };
    const row = mapFeatureToLake(feature);
    expect(row.name).toBeNull();
  });

  it("sets name to null when MS_NAME is empty string", () => {
    const feature = {
      ...FIXTURE_FEATURE,
      properties: { ...FIXTURE_FEATURE.properties, MS_NAME: "" },
    };
    const row = mapFeatureToLake(feature);
    expect(row.name).toBeNull();
  });

  it("throws when required properties are missing", () => {
    const bad = {
      ...FIXTURE_FEATURE,
      properties: { ...FIXTURE_FEATURE.properties, MS_CD: undefined },
    };
    expect(() => mapFeatureToLake(bad)).toThrow();
  });
});
