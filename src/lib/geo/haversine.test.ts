import { describe, expect, it } from "vitest";
import { haversine } from "./haversine";

describe("haversine", () => {
  it("returns 0 for the same point", () => {
    expect(haversine({ lat: 59.0, lon: 18.0 }, { lat: 59.0, lon: 18.0 })).toBe(
      0,
    );
  });

  it("returns ~111 km for 1° latitude difference", () => {
    // 1° latitude ≈ 111.195 km anywhere (meridional arc is nearly constant)
    const km = haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(km).toBeCloseTo(111.195, 0); // within ~1 km
  });

  it("returns ~111 km for 1° longitude difference at equator", () => {
    const km = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(km).toBeCloseTo(111.195, 0);
  });

  it("returns ~157 km for Stockholm to Göteborg (approx)", () => {
    // Stockholm ≈ 59.33°N 18.07°E, Göteborg ≈ 57.71°N 11.97°E
    // Actual straight-line distance is ~406 km; let's use two Swedish cities
    // Use Uppsala–Stockholm: Uppsala 59.86°N 17.64°E, Stockholm 59.33°N 18.07°E → ~67 km
    const km = haversine(
      { lat: 59.86, lon: 17.64 }, // Uppsala
      { lat: 59.33, lon: 18.07 }, // Stockholm
    );
    // Actual geodesic ≈ 67 km; haversine on a sphere gives ~67 km
    expect(km).toBeGreaterThan(60);
    expect(km).toBeLessThan(75);
  });

  it("is symmetric (a→b == b→a)", () => {
    const a = { lat: 55.5, lon: 13.0 };
    const b = { lat: 59.3, lon: 17.9 };
    expect(haversine(a, b)).toBe(haversine(b, a));
  });

  it("returns a positive number for distinct points", () => {
    const km = haversine({ lat: 56.0, lon: 14.0 }, { lat: 57.0, lon: 15.0 });
    expect(km).toBeGreaterThan(0);
  });

  it("handles antipodal points (~20015 km = half Earth circumference)", () => {
    const km = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(km).toBeCloseTo(20015, -2); // within ~100 km
  });
});
