/**
 * Unit tests for species lookups and normalization — pure functions only.
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
import { normalizeSpecies } from "./species";

// ────────────────────────────────────────────────────────────────────────────
// normalizeSpecies — pure mapper, no DB/network
// ────────────────────────────────────────────────────────────────────────────

describe("normalizeSpecies", () => {
  it("returns empty array for empty input", () => {
    expect(normalizeSpecies([])).toEqual([]);
  });

  it("deduplicates identical species names", () => {
    const result = normalizeSpecies(["abborre", "gädda", "abborre"]);
    expect(result).toEqual(["abborre", "gädda"]);
  });

  it("normalizes to lower case", () => {
    const result = normalizeSpecies(["Abborre", "GÄDDA", "Braxen"]);
    expect(result).toContain("abborre");
    expect(result).toContain("gädda");
    expect(result).toContain("braxen");
  });

  it("trims surrounding whitespace", () => {
    const result = normalizeSpecies(["  abborre  ", " gädda"]);
    expect(result).toContain("abborre");
    expect(result).toContain("gädda");
  });

  it("filters out blank / whitespace-only entries", () => {
    const result = normalizeSpecies(["abborre", "", "  ", "gädda"]);
    expect(result).not.toContain("");
    expect(result).not.toContain("  ");
    expect(result).toEqual(["abborre", "gädda"]);
  });

  it("deduplicates after normalization (case-insensitive dedup)", () => {
    const result = normalizeSpecies(["Abborre", "abborre", "ABBORRE"]);
    expect(result).toEqual(["abborre"]);
  });

  it("preserves order of first occurrence", () => {
    const result = normalizeSpecies(["gädda", "abborre", "braxen", "gädda"]);
    expect(result).toEqual(["gädda", "abborre", "braxen"]);
  });

  it("handles a realistic Swedish fish species list", () => {
    const raw = [
      "Abborre",
      "Gädda",
      "Mört",
      "Braxen",
      "abborre", // duplicate after normalize
      "Lake",
    ];
    const result = normalizeSpecies(raw);
    expect(result).toHaveLength(5);
    expect(result).toContain("abborre");
    expect(result).toContain("gädda");
    expect(result).toContain("mört");
    expect(result).toContain("braxen");
    expect(result).toContain("lake");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// speciesFor — DB-backed lookup (db layer mocked)
// ────────────────────────────────────────────────────────────────────────────

// Mock the lazy DB imports that speciesFor uses internally.
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
  lakeSpecies: {
    lakeId: "lakeId",
    species: "species",
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

// Import speciesFor AFTER setting up mocks (lazy imports in implementation
// mean the module-level mock is sufficient).
import { speciesFor } from "./species";

describe("speciesFor", () => {
  it("returns null when no row exists for the given lakeId (graceful absence)", async () => {
    mockLimit.mockResolvedValue([]);
    const result = await speciesFor("lake-that-has-not-been-surveyed");
    expect(result).toBeNull();
  });

  it("returns the species array when a row exists", async () => {
    mockLimit.mockResolvedValue([
      { species: ["abborre", "gädda", "mört"], confidence: "high" },
    ]);
    const result = await speciesFor("lake-with-survey-data");
    expect(result).not.toBeNull();
    expect(result).toEqual(["abborre", "gädda", "mört"]);
  });

  it("returns an empty array (not null) when the row exists but species is empty", async () => {
    mockLimit.mockResolvedValue([{ species: [], confidence: "low" }]);
    const result = await speciesFor("lake-with-empty-species");
    expect(result).toEqual([]);
    // Explicit: empty array is not null — row was found, just no species listed
    expect(result).not.toBeNull();
  });

  it("returns null for a second absent lake (no cross-contamination between calls)", async () => {
    mockLimit.mockResolvedValue([]);
    const result = await speciesFor("another-absent-lake-999");
    expect(result).toBeNull();
  });
});
