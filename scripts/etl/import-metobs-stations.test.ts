import { describe, expect, it } from "vitest";
import { mapStation } from "./import-metobs-stations";

// Fixture: a representative metobs station as returned by SMHI Open Data API.
// Field names follow the SMHI metobs station-list JSON schema documented at:
//   https://opendata.smhi.se/apidocs/metobs/
const FIXTURE_STATION = {
  id: 52350,
  name: "Stockholm",
  latitude: 59.3458,
  longitude: 18.0717,
  active: true,
  from: 1756001600000,
  to: 99999999999999,
};

describe("mapStation", () => {
  it("maps a raw station to a metobsStations row for 'pressure'", () => {
    const row = mapStation(FIXTURE_STATION, "pressure");

    expect(row.id).toBe("52350");
    expect(row.name).toBe("Stockholm");
    expect(row.lat).toBe(59.3458);
    expect(row.lon).toBe(18.0717);
    expect(row.parameter).toBe("pressure");
  });

  it("maps a raw station to a metobsStations row for 'temp'", () => {
    const row = mapStation(FIXTURE_STATION, "temp");

    expect(row.id).toBe("52350");
    expect(row.name).toBe("Stockholm");
    expect(row.lat).toBe(59.3458);
    expect(row.lon).toBe(18.0717);
    expect(row.parameter).toBe("temp");
  });

  it("throws when required id is missing", () => {
    const bad = { ...FIXTURE_STATION, id: undefined };
    expect(() => mapStation(bad, "temp")).toThrow();
  });

  it("throws when required name is missing", () => {
    const bad = { ...FIXTURE_STATION, name: undefined };
    expect(() => mapStation(bad, "pressure")).toThrow();
  });

  it("throws when lat is missing", () => {
    const bad = { ...FIXTURE_STATION, latitude: undefined };
    expect(() => mapStation(bad, "temp")).toThrow();
  });

  it("throws when lon is missing", () => {
    const bad = { ...FIXTURE_STATION, longitude: undefined };
    expect(() => mapStation(bad, "pressure")).toThrow();
  });
});
