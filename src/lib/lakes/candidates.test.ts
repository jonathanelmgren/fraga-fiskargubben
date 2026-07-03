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
import type { Lake } from "./resolve";
import { attachDistances, candidateLakes } from "./candidates";

const asunden: Lake = {
  id: "lake-asunden",
  name: "Åsunden",
  municipality: "Borås",
  county: "Västra Götaland",
  lat: 57.71,
  lon: 13.4,
  areaHa: 3300,
};

describe("attachDistances", () => {
  it("returns rows untouched without a user location", () => {
    const out = attachDistances([asunden]);
    expect(out[0].distanceKm).toBeUndefined();
  });

  it("attaches rounded haversine distance from the user location", () => {
    // Ulricehamn town centre — ~10 km from the Åsunden centroid above.
    const out = attachDistances([asunden], { lat: 57.79, lon: 13.42 });
    expect(out[0].distanceKm).toBeDefined();
    expect(out[0].distanceKm).toBeGreaterThan(5);
    expect(out[0].distanceKm).toBeLessThan(15);
    // one decimal
    expect(out[0].distanceKm).toBe(Math.round((out[0].distanceKm ?? 0) * 10) / 10);
  });

  it("does not mutate input rows", () => {
    const rows = [{ ...asunden }];
    attachDistances(rows, { lat: 58, lon: 13 });
    expect("distanceKm" in rows[0]).toBe(false);
  });
});

describe("candidateLakes (no-IO paths)", () => {
  it("returns [] when both name and location are empty", async () => {
    await expect(candidateLakes("")).resolves.toEqual([]);
    await expect(candidateLakes("   ")).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — require a real Postgres with lakes table + pg_trgm.
// Gated: skipped when DATABASE_URL is not set in the environment.
// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("candidateLakes (integration)", () => {
  it("finds fuzzy name candidates without municipality filtering", async () => {
    const hits = await candidateLakes("Åsunden");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(10);
    for (const hit of hits) {
      expect(hit.name).toBeTruthy();
      expect(hit.municipality).toBeTruthy();
      expect(typeof hit.areaHa).toBe("number");
    }
  });

  it("returns nearby named lakes for a bare location", async () => {
    // Ulricehamn
    const hits = await candidateLakes("", { lat: 57.79, lon: 13.42 });
    expect(hits.length).toBeGreaterThan(0);
    // ordered by distance
    const dists = hits.map((h) => h.distanceKm ?? 0);
    expect([...dists].sort((a, b) => a - b)).toEqual(dists);
  });
});
