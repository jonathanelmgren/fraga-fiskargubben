// vi.mock calls are hoisted — these always run, even before imports.
import { vi } from "vitest";

// Allow server-only imports in the test environment.
vi.mock("server-only", () => ({}));

// Stub the env module so Zod validation doesn't blow up on missing secrets.
// DATABASE_URL is real; the rest are irrelevant for lake resolution.
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

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper tests — no DB required, always run
// ─────────────────────────────────────────────────────────────────────────────
import { formatLabel } from "./resolve-helpers";

describe("formatLabel", () => {
  it("formats name, municipality and county", () => {
    expect(
      formatLabel({
        name: "Tolken",
        municipality: "Ulricehamn",
        county: "Västra Götaland",
      }),
    ).toBe("Tolken (Ulricehamn, Västra Götaland)");
  });

  it("uses whitespace from the values as-is", () => {
    expect(
      formatLabel({
        name: "Stora Hällsjön",
        municipality: "Borås",
        county: "Västra Götaland",
      }),
    ).toBe("Stora Hällsjön (Borås, Västra Götaland)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — require a real Postgres with lakes table + pg_trgm.
// Gated: skipped when DATABASE_URL is not set in the environment.
// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("searchLakes + resolveLake (integration)", () => {
  // Test fixture lake IDs — use a unique prefix so cleanup is easy.
  const TEST_LAKES = [
    // Three lakes named "Tolken" in different municipalities with different areas.
    {
      id: "TEST_TOLKEN_ULRICE",
      name: "Tolken",
      municipality: "Ulricehamn",
      county: "Västra Götaland",
      lat: 57.7,
      lon: 13.4,
      areaHa: 500,
    },
    {
      id: "TEST_TOLKEN_BORAS",
      name: "Tolken",
      municipality: "Borås",
      county: "Västra Götaland",
      lat: 57.8,
      lon: 13.5,
      areaHa: 250,
    },
    {
      id: "TEST_TOLKEN_MARKS",
      name: "Tolken",
      municipality: "Mark",
      county: "Västra Götaland",
      lat: 57.6,
      lon: 13.3,
      areaHa: 100,
    },
    // A prefix-match variant (should rank below exact, above trigram-only).
    {
      id: "TEST_TOLKABAD",
      name: "Tolkabad",
      municipality: "Marks",
      county: "Västra Götaland",
      lat: 57.5,
      lon: 13.2,
      areaHa: 50,
    },
    // Unnamed body — must be excluded from search results.
    {
      id: "TEST_UNNAMED",
      name: null,
      municipality: "Borås",
      county: "Västra Götaland",
      lat: 57.9,
      lon: 13.6,
      areaHa: 10,
    },
  ];

  beforeEach(async () => {
    const { db } = await import("@/shared/db/client");
    const { lakes } = await import("@/shared/db/schema");
    // Insert test fixtures (skip if already exist from a crashed prior run).
    await db.insert(lakes).values(TEST_LAKES).onConflictDoNothing();
  });

  afterEach(async () => {
    const { db } = await import("@/shared/db/client");
    const { sql } = await import("drizzle-orm");
    const { lakes } = await import("@/shared/db/schema");
    await db.delete(lakes).where(sql`id LIKE ${"TEST_%"}`);
  });

  describe("searchLakes", () => {
    it("returns exact-name matches ranked by areaHa DESC", async () => {
      const { searchLakes } = await import("./resolve");
      const hits = await searchLakes("Tolken");
      const tolkens = hits.filter((h) => h.name === "Tolken");
      expect(tolkens.length).toBeGreaterThanOrEqual(3);
      // Largest first.
      const areas = tolkens.map(
        (h) => TEST_LAKES.find((l) => l.id === h.id)?.areaHa ?? 0,
      );
      expect(areas).toEqual([...areas].sort((a, b) => b - a));
    });

    it("returns exact matches before prefix matches", async () => {
      const { searchLakes } = await import("./resolve");
      const hits = await searchLakes("Tolken");
      const tolkIdx = hits.findIndex((h) => h.name === "Tolken");
      const tolkabadIdx = hits.findIndex((h) => h.name === "Tolkabad");
      // All exact matches appear before Tolkabad.
      if (tolkabadIdx !== -1) {
        expect(tolkIdx).toBeLessThan(tolkabadIdx);
      }
    });

    it("excludes unnamed water bodies", async () => {
      const { searchLakes } = await import("./resolve");
      const hits = await searchLakes("Tolken");
      expect(hits.every((h) => h.name !== null && h.name !== undefined)).toBe(
        true,
      );
    });

    it("formats labels as 'name (municipality, county)'", async () => {
      const { searchLakes } = await import("./resolve");
      const hits = await searchLakes("Tolken");
      const ulrice = hits.find((h) => h.id === "TEST_TOLKEN_ULRICE");
      expect(ulrice?.label).toBe("Tolken (Ulricehamn, Västra Götaland)");
    });

    it("returns at most 10 results", async () => {
      const { searchLakes } = await import("./resolve");
      const hits = await searchLakes("Tolken");
      expect(hits.length).toBeLessThanOrEqual(10);
    });

    it("returns id, name, label, lat, lon on each hit", async () => {
      const { searchLakes } = await import("./resolve");
      const hits = await searchLakes("Tolken");
      for (const hit of hits.slice(0, 3)) {
        expect(hit).toHaveProperty("id");
        expect(hit).toHaveProperty("name");
        expect(hit).toHaveProperty("label");
        expect(hit).toHaveProperty("lat");
        expect(hit).toHaveProperty("lon");
      }
    });
  });

  describe("resolveLake", () => {
    it("returns the unique lake when municipality pins it", async () => {
      const { resolveLake } = await import("./resolve");
      const lake = await resolveLake("Tolken", "Ulricehamn");
      expect(lake).not.toBeNull();
      expect(lake?.id).toBe("TEST_TOLKEN_ULRICE");
    });

    it("returns null when no lake matches the name+municipality", async () => {
      const { resolveLake } = await import("./resolve");
      const lake = await resolveLake("Tolken", "Stockholm");
      expect(lake).toBeNull();
    });

    it("returns null when municipality is ambiguous (multiple matches)", async () => {
      const { resolveLake } = await import("./resolve");
      // Without a municipality, "Tolken" matches 3 lakes → ambiguous → null.
      const lake = await resolveLake("Tolken");
      expect(lake).toBeNull();
    });

    it("returns the single lake when municipality narrows to one", async () => {
      const { resolveLake } = await import("./resolve");
      const lake = await resolveLake("Tolkabad", "Marks");
      expect(lake?.id).toBe("TEST_TOLKABAD");
    });

    it("returns null for unknown lake name", async () => {
      const { resolveLake } = await import("./resolve");
      const lake = await resolveLake("XxNonexistentLakeXx");
      expect(lake).toBeNull();
    });

    it("includes full lake fields on the returned lake", async () => {
      const { resolveLake } = await import("./resolve");
      const lake = await resolveLake("Tolkabad", "Marks");
      expect(lake).toMatchObject({
        id: "TEST_TOLKABAD",
        name: "Tolkabad",
        municipality: "Marks",
        county: "Västra Götaland",
      });
      expect(typeof lake?.lat).toBe("number");
      expect(typeof lake?.lon).toBe("number");
      expect(typeof lake?.areaHa).toBe("number");
    });
  });
});
