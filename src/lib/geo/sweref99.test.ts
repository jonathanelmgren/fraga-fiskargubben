import { describe, expect, it } from "vitest";
import { sweref99ToWgs84 } from "./sweref99";

// Ground-truth SWEREF99TM ↔ WGS84 pairs taken from the live VISS API response
// (each water body carries both a SWEREF99 and a LatLong coordinate for the
// same centroid), verified 2026-07-02. The transform must reproduce the WGS84
// value from the SWEREF99 input to sub-metre accuracy.
const PAIRS = [
  {
    name: "Femunden",
    n: 6_896_863,
    e: 337_228,
    lat: 62.168353608048,
    lon: 11.8741853467973,
  },
  {
    name: "Galtsjöen",
    n: 6_866_513,
    e: 328_963,
    lat: 61.8926911384646,
    lon: 11.7449851353084,
  },
  {
    name: "Vermunden",
    n: 6_731_488,
    e: 357_196,
    lat: 60.6934648131074,
    lon: 12.3843681870764,
  },
  {
    name: "Mökeren",
    n: 6_673_056,
    e: 353_299,
    lat: 60.1679792837269,
    lon: 12.3560113259606,
  },
];

/** Rough metre error between two WGS84 points (good enough for a tolerance). */
function metresApart(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = (aLat - bLat) * 111_000;
  const dLon = (aLon - bLon) * 111_000 * Math.cos((aLat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

describe("sweref99ToWgs84", () => {
  for (const p of PAIRS) {
    it(`reprojects ${p.name} to within 1 m of the known WGS84 point`, () => {
      const got = sweref99ToWgs84(p.n, p.e);
      expect(got).not.toBeNull();
      if (!got) return;
      expect(metresApart(got.lat, got.lon, p.lat, p.lon)).toBeLessThan(1);
    });
  }

  it("returns lat/lon in plausible Swedish ranges", () => {
    const got = sweref99ToWgs84(6_580_822, 674_032); // ~Stockholm area
    expect(got).not.toBeNull();
    if (!got) return;
    expect(got.lat).toBeGreaterThan(55);
    expect(got.lat).toBeLessThan(69);
    expect(got.lon).toBeGreaterThan(10);
    expect(got.lon).toBeLessThan(25);
  });

  it("returns null for non-finite input", () => {
    expect(sweref99ToWgs84(Number.NaN, 500_000)).toBeNull();
    expect(sweref99ToWgs84(6_500_000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
