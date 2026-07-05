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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachDistances, candidateLakes } from "./candidates";
import type { Lake } from "./resolve";

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
    expect(out[0].distanceKm).toBe(
      Math.round((out[0].distanceKm ?? 0) * 10) / 10,
    );
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
  // Self-seeded fixtures (CI runs against an EMPTY migrated DB — same pattern
  // as resolve.test.ts). Unique TESTC_ prefix so cleanup is a single delete.
  const TEST_LAKES = [
    {
      id: "TESTC_ASUNDEN_BORAS",
      name: "Åsunden",
      municipality: "Borås",
      county: "Västra Götaland",
      lat: 57.71,
      lon: 13.4,
      areaHa: 3300,
    },
    {
      id: "TESTC_ASUNDEN_KINDA",
      name: "Åsunden",
      municipality: "Kinda",
      county: "Östergötland",
      lat: 57.99,
      lon: 15.75,
      areaHa: 5500,
    },
    // Trigram-only neighbour (no shared prefix: Åsunden vs Asunden differ at
    // char 1) — proves candidates are broader than exact/prefix.
    {
      id: "TESTC_ASUNDEN_TRIGRAM",
      name: "Asunden",
      municipality: "Ulricehamn",
      county: "Västra Götaland",
      lat: 57.75,
      lon: 13.45,
      areaHa: 120,
    },
    // Nearby-mode fixtures around Ulricehamn (57.79, 13.42).
    {
      id: "TESTC_NEAR_SMALL",
      name: "Lillsjön",
      municipality: "Ulricehamn",
      county: "Västra Götaland",
      lat: 57.8,
      lon: 13.43,
      areaHa: 15,
    },
    {
      id: "TESTC_NEAR_FAR",
      name: "Bortresjön",
      municipality: "Borås",
      county: "Västra Götaland",
      lat: 57.9,
      lon: 13.1,
      areaHa: 200,
    },
    // Unnamed body — must never appear as a candidate.
    {
      id: "TESTC_UNNAMED",
      name: null,
      municipality: "Ulricehamn",
      county: "Västra Götaland",
      lat: 57.79,
      lon: 13.42,
      areaHa: 50,
    },
  ];

  beforeEach(async () => {
    const { db } = await import("@/shared/db/client");
    const { lakes } = await import("@/shared/db/schema");
    await db.insert(lakes).values(TEST_LAKES).onConflictDoNothing();
  });

  afterEach(async () => {
    const { db } = await import("@/shared/db/client");
    const { sql } = await import("drizzle-orm");
    const { lakes } = await import("@/shared/db/schema");
    await db.delete(lakes).where(sql`id LIKE ${"TESTC_%"}`);
  });

  it("finds fuzzy name candidates without municipality filtering", async () => {
    const hits = await candidateLakes("Åsunden");
    const ours = hits.filter((h) => h.id.startsWith("TESTC_"));
    // Both same-name lakes from different municipalities/counties…
    expect(ours.map((h) => h.id)).toContain("TESTC_ASUNDEN_BORAS");
    expect(ours.map((h) => h.id)).toContain("TESTC_ASUNDEN_KINDA");
    // …and the trigram-only neighbour is included (broad by design).
    expect(ours.map((h) => h.id)).toContain("TESTC_ASUNDEN_TRIGRAM");
    expect(hits.length).toBeLessThanOrEqual(10);
    for (const hit of hits) {
      expect(hit.name).toBeTruthy();
      expect(hit.municipality).toBeTruthy();
      expect(typeof hit.areaHa).toBe("number");
    }
  });

  it("attaches distances when a user location is given", async () => {
    const hits = await candidateLakes("Åsunden", { lat: 57.79, lon: 13.42 });
    const boras = hits.find((h) => h.id === "TESTC_ASUNDEN_BORAS");
    expect(boras?.distanceKm).toBeDefined();
    expect(boras?.distanceKm).toBeLessThan(20);
  });

  it("returns nearby named lakes for a bare location, ordered by distance", async () => {
    // Ulricehamn
    const hits = await candidateLakes("", { lat: 57.79, lon: 13.42 });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("TESTC_NEAR_SMALL");
    // The unnamed body sitting exactly at the user location is excluded.
    expect(ids).not.toContain("TESTC_UNNAMED");
    // Ordered by distance.
    const dists = hits.map((h) => h.distanceKm ?? 0);
    expect([...dists].sort((a, b) => a - b)).toEqual(dists);
  });
});
