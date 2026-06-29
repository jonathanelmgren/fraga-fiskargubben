// vi.mock calls are hoisted — these always run, even before imports.
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
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

import { describe, expect, it } from "vitest";
import fixtureRaw from "./__fixtures__/snow1g-sample.json";
import { isFresh, pickEntry, type SmhiForecastDoc } from "./forecast";

// Cast the JSON fixture to SmhiForecastDoc so TypeScript can verify the tuple
// [lon, lat] constraint on geometry.coordinates at the call sites below.
const fixture = fixtureRaw as unknown as SmhiForecastDoc;

// ─────────────────────────────────────────────────────────────────────────────
// pickEntry — pure, no DB
// ─────────────────────────────────────────────────────────────────────────────

describe("pickEntry", () => {
  it("picks the entry whose time is exactly the target", () => {
    const result = pickEntry(fixture, "2024-06-15T12:00:00Z");
    expect(result.entry.time).toBe("2024-06-15T12:00:00Z");
    expect(result.snapDeltaMinutes).toBe(0);
  });

  it("picks the nearest entry when target is between two entries", () => {
    // Target is 10:20 — closest to 10:00 (20 min away) vs 11:00 (40 min away)
    const result = pickEntry(fixture, "2024-06-15T10:20:00Z");
    expect(result.entry.time).toBe("2024-06-15T10:00:00Z");
    expect(result.snapDeltaMinutes).toBe(20);
  });

  it("picks the later entry when equidistant (tie-break toward future)", () => {
    // Target is 10:30 — exactly 30 min from 10:00 and 11:00; pick 11:00
    const result = pickEntry(fixture, "2024-06-15T10:30:00Z");
    expect(result.entry.time).toBe("2024-06-15T11:00:00Z");
    expect(result.snapDeltaMinutes).toBe(30);
  });

  it("returns correct snap delta in minutes", () => {
    // Target is 11:45 — closest to 12:00 (15 min away)
    const result = pickEntry(fixture, "2024-06-15T11:45:00Z");
    expect(result.entry.time).toBe("2024-06-15T12:00:00Z");
    expect(result.snapDeltaMinutes).toBe(15);
  });

  it("filters sentinel value 9999 — wind_speed is undefined, not 9999", () => {
    // The 11:00 entry has wind_speed: 9999
    const result = pickEntry(fixture, "2024-06-15T11:00:00Z");
    expect(result.params.wind_speed).toBeUndefined();
  });

  it("filters sentinel value 9999 — wind_from_direction is undefined, not 9999", () => {
    const result = pickEntry(fixture, "2024-06-15T11:00:00Z");
    expect(result.params.wind_from_direction).toBeUndefined();
  });

  it("keeps real values intact (no false 9999 filter)", () => {
    const result = pickEntry(fixture, "2024-06-15T12:00:00Z");
    expect(result.params.wind_speed).toBe(4.1);
    expect(result.params.air_temperature).toBe(16.0);
  });

  it("extracts all expected param keys from a non-sentinel entry", () => {
    const result = pickEntry(fixture, "2024-06-15T12:00:00Z");
    expect(result.params).toMatchObject({
      air_temperature: 16.0,
      air_pressure_at_mean_sea_level: 1012.0,
      wind_speed: 4.1,
      wind_from_direction: 260,
      cloud_area_fraction: 60,
      symbol_code: 2,
      precipitation_amount_mean: 0.0,
    });
  });

  it("compares times in UTC (ISO strings are UTC)", () => {
    // Explicit UTC target, same as "2024-06-15T10:00:00Z"
    const result = pickEntry(fixture, "2024-06-15T10:00:00.000Z");
    expect(result.entry.time).toBe("2024-06-15T10:00:00Z");
    expect(result.snapDeltaMinutes).toBe(0);
  });

  it("throws a clear error when timeSeries is empty", () => {
    const emptyDoc: SmhiForecastDoc = {
      ...fixture,
      timeSeries: [],
    };
    expect(() => pickEntry(emptyDoc, "2024-06-15T12:00:00Z")).toThrow(
      /empty timeSeries/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFresh — pure, no DB
// ─────────────────────────────────────────────────────────────────────────────

describe("isFresh", () => {
  it("returns true when fetchedAt is less than 1h ago", () => {
    const now = new Date("2024-06-15T12:00:00Z");
    const fetchedAt = new Date("2024-06-15T11:30:00Z"); // 30 min ago
    expect(isFresh(fetchedAt, now)).toBe(true);
  });

  it("returns false when fetchedAt is exactly 1h ago", () => {
    const now = new Date("2024-06-15T12:00:00Z");
    const fetchedAt = new Date("2024-06-15T11:00:00Z"); // exactly 1h
    expect(isFresh(fetchedAt, now)).toBe(false);
  });

  it("returns false when fetchedAt is more than 1h ago", () => {
    const now = new Date("2024-06-15T12:00:00Z");
    const fetchedAt = new Date("2024-06-15T10:30:00Z"); // 90 min ago
    expect(isFresh(fetchedAt, now)).toBe(false);
  });

  it("returns true when fetchedAt is exactly now", () => {
    const now = new Date("2024-06-15T12:00:00Z");
    expect(isFresh(now, now)).toBe(true);
  });
});
