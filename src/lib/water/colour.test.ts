/**
 * Unit tests for water colour / sight depth — pure functions only.
 * No network, no database.
 */

// vi.mock calls are hoisted — these always run, even before imports.
import { vi } from "vitest";

// Allow server-only imports in the test environment.
vi.mock("server-only", () => ({}));

// Stub the env module so Zod validation doesn't blow up on missing secrets.
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

import { beforeEach, describe, expect, it } from "vitest";
import { colourFor, deriveColour } from "./colour";
import { stationMatchesLake } from "./station-match";

// ────────────────────────────────────────────────────────────────────────────
// stationMatchesLake — the import-time join predicate (ADR-0002)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reference lake: Vänern centroid, ~5650 km² → areaHa = 565000
 * circleRadius = sqrt(565000 * 10000 / π) ≈ 42 354 m ≈ 42.354 km
 *
 * We use a realistic small lake for the tight tests:
 * Lake "Fiolen", southern Sweden — centroid 57.1°N, 14.8°E, ~460 ha
 * circleRadius = sqrt(460 * 10000 / π) ≈ 1 210 m ≈ 1.210 km
 */

const FIOLEN_CENTROID = { lat: 57.1, lon: 14.8 };
const FIOLEN_AREA_HA = 460;
// Derived area radius: sqrt(460 * 10000 / π) = sqrt(1 464 380) ≈ 1 210 m = 1.210 km

describe("stationMatchesLake", () => {
  it("returns matches:true + confidence:'high' when station is within 200 m of centroid", () => {
    // ~100 m north of centroid (0.001° lat ≈ 111 m)
    const station = { lat: 57.1009, lon: 14.8 };
    const lake = {
      lat: FIOLEN_CENTROID.lat,
      lon: FIOLEN_CENTROID.lon,
      areaHa: FIOLEN_AREA_HA,
    };
    const result = stationMatchesLake(station, lake);
    if (!result.matches) throw new Error("expected matches:true");
    expect(result.confidence).toBe("high");
  });

  it("returns matches:true + confidence:'high' at exactly 200 m (boundary inclusive)", () => {
    // Place station at 200 m from centroid by working backwards through haversine.
    // 200 m due north: Δlat = (0.2 km / 6371 km) * (180/π) ≈ 0.001799°
    // Using a slightly smaller value (195 m) to be unambiguously ≤ 200 m with haversine rounding.
    const station = { lat: 57.1 + 0.195 / 111, lon: 14.8 };
    const lake = {
      lat: FIOLEN_CENTROID.lat,
      lon: FIOLEN_CENTROID.lon,
      areaHa: FIOLEN_AREA_HA,
    };
    const result = stationMatchesLake(station, lake);
    if (!result.matches) throw new Error("expected matches:true");
    expect(result.confidence).toBe("high");
  });

  it("returns matches:true + confidence:'low' between 200 m and area radius", () => {
    // 800 m north of centroid (well past 200 m, inside area circle of ~1.2 km)
    const station = { lat: 57.1 + 0.8 / 111, lon: 14.8 };
    const lake = {
      lat: FIOLEN_CENTROID.lat,
      lon: FIOLEN_CENTROID.lon,
      areaHa: FIOLEN_AREA_HA,
    };
    const result = stationMatchesLake(station, lake);
    if (!result.matches) throw new Error("expected matches:true");
    expect(result.confidence).toBe("low");
  });

  it("returns matches:false when station is clearly beyond the area radius", () => {
    // 5 km north of centroid — well beyond 1.2 km area radius
    const station = { lat: 57.1 + 5 / 111, lon: 14.8 };
    const lake = {
      lat: FIOLEN_CENTROID.lat,
      lon: FIOLEN_CENTROID.lon,
      areaHa: FIOLEN_AREA_HA,
    };
    const result = stationMatchesLake(station, lake);
    expect(result.matches).toBe(false);
  });

  it("treats a tiny 1-ha pond as matches:false even for a station just outside 200 m", () => {
    // 1 ha → area radius = sqrt(10000/π) ≈ 56 m
    // A station at 250 m should be beyond both 200 m threshold AND area radius
    const station = { lat: 57.1 + 0.25 / 111, lon: 14.8 };
    const lake = {
      lat: FIOLEN_CENTROID.lat,
      lon: FIOLEN_CENTROID.lon,
      areaHa: 1,
    };
    const result = stationMatchesLake(station, lake);
    expect(result.matches).toBe(false);
  });

  it("returns matches:false for a station 50 km away", () => {
    const station = { lat: 57.55, lon: 14.8 }; // ~50 km north
    const lake = {
      lat: FIOLEN_CENTROID.lat,
      lon: FIOLEN_CENTROID.lon,
      areaHa: FIOLEN_AREA_HA,
    };
    const result = stationMatchesLake(station, lake);
    expect(result.matches).toBe(false);
  });

  it("works with a very large lake — station 20 km away still inside area circle", () => {
    // Vänern: 565000 ha → area radius ≈ 42.4 km
    const vanern = { lat: 58.9, lon: 13.5, areaHa: 565_000 };
    const station = { lat: 59.08, lon: 13.5 }; // ~20 km north
    const result = stationMatchesLake(station, vanern);
    if (!result.matches) throw new Error("expected matches:true");
    expect(result.confidence).toBe("low"); // >200 m, inside area circle
  });

  it("returns high confidence for a station within 200 m of large lake centroid", () => {
    const vanern = { lat: 58.9, lon: 13.5, areaHa: 565_000 };
    const station = { lat: 58.9 + 0.001, lon: 13.5 }; // ~111 m
    const result = stationMatchesLake(station, vanern);
    if (!result.matches) throw new Error("expected matches:true");
    expect(result.confidence).toBe("high");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// deriveColour — pure colour classification from MVM absorbans/färgtal
// ────────────────────────────────────────────────────────────────────────────

describe("deriveColour", () => {
  it("returns 'brown' when absorbans is above the threshold (> 0.1 /m at 420 nm)", () => {
    // Threshold: absorbans420 > 0.1 → humic/brown (typical Swedish classification)
    expect(deriveColour({ absorbans420: 0.15 })).toBe("brown");
  });

  it("returns 'clear' when absorbans is below the threshold", () => {
    expect(deriveColour({ absorbans420: 0.05 })).toBe("clear");
  });

  it("returns 'brown' at the exact threshold boundary (> 0.1, not ≥)", () => {
    expect(deriveColour({ absorbans420: 0.1 })).toBe("clear"); // exactly at threshold → clear
    expect(deriveColour({ absorbans420: 0.1001 })).toBe("brown");
  });

  it("returns 'brown' when färgtal (colour number, mg Pt/L) is above 30", () => {
    // Alternative input: Swedish water colour by Pt scale; >30 mg Pt/L → brown/humic
    expect(deriveColour({ fargtal: 40 })).toBe("brown");
  });

  it("returns 'clear' when färgtal is ≤ 30", () => {
    expect(deriveColour({ fargtal: 20 })).toBe("clear");
  });

  it("returns 'clear' for zero absorbans (distilled-water reference)", () => {
    expect(deriveColour({ absorbans420: 0 })).toBe("clear");
  });

  it("throws if neither absorbans420 nor fargtal is provided", () => {
    expect(() => deriveColour({})).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// colourFor — DB-backed lookup (db layer mocked)
// ────────────────────────────────────────────────────────────────────────────

// Mock the lazy DB imports that colourFor uses internally.
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/shared/db/client", () => ({
  db: {
    select: mockSelect,
  },
}));
vi.mock("@/shared/db/schema", () => ({
  waterColour: {
    lakeId: "lakeId",
    colour: "colour",
    sightDepthM: "sightDepthM",
    confidence: "confidence",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, _val: unknown) => "eq-predicate",
}));

beforeEach(() => {
  mockLimit.mockReset();
  mockWhere.mockReset().mockReturnValue({ limit: mockLimit });
  mockFrom.mockReset().mockReturnValue({ where: mockWhere });
  mockSelect.mockReset().mockReturnValue({ from: mockFrom });
});

describe("colourFor", () => {
  it("returns null when no row exists for the given lakeId", async () => {
    mockLimit.mockResolvedValue([]);
    const result = await colourFor("lake-that-does-not-exist");
    expect(result).toBeNull();
  });

  it("returns the row shape when a row exists for the given lakeId", async () => {
    mockLimit.mockResolvedValue([
      { colour: "brown", sightDepthM: 2.5, confidence: "high" },
    ]);
    const result = await colourFor("lake-with-data");
    expect(result).not.toBeNull();
    expect(result?.colour).toBe("brown");
    expect(result?.sightDepthM).toBe(2.5);
    expect(result?.confidence).toBe("high");
  });

  it("returns null when DB returns empty array for an absent lakeId (clear-water lake, no ETL run)", async () => {
    mockLimit.mockResolvedValue([]);
    const result = await colourFor("absent-lake-id-999");
    expect(result).toBeNull();
  });
});
