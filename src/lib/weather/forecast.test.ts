// vi.mock calls are hoisted — these always run, even before imports.
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
// Mock the DB client so the cache helpers (cacheGet/cacheSet) can be driven
// per-test without a real Postgres. Each test reconfigures db.select/db.insert.
vi.mock("@/shared/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
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
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import { db } from "@/shared/db/client";
import fixtureRaw from "./__fixtures__/snow1g-sample.json";
import {
  fetchForecast,
  getForecast,
  isFresh,
  pickEntry,
  type SmhiForecastDoc,
} from "./forecast";

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

// ─────────────────────────────────────────────────────────────────────────────
// fetchForecast — typed errors (H3b)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchForecast — typed errors", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("throws ExternalServiceError with status on a non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("upstream error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    try {
      await fetchForecast(57.7, 13.0);
      throw new Error("expected fetchForecast to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect((err as ExternalServiceError).status).toBe(500);
      expect((err as ExternalServiceError).service).toBe("smhi-forecast");
    }
  });

  it("throws TimeoutError when the fetch aborts with a TimeoutError DOMException", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    await expect(fetchForecast(57.7, 13.0)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("throws ExternalServiceError on a malformed shape (no timeSeries)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ geometry: {} }));

    await expect(fetchForecast(57.7, 13.0)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it("returns the doc on a well-formed response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json(fixture));
    const doc = await fetchForecast(57.7, 13.0);
    expect(Array.isArray(doc.timeSeries)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getForecast — cache degradation (H3b / M2)
// ─────────────────────────────────────────────────────────────────────────────

/** Build a db.select(...).from(...).where(...).limit(...) chain. */
function selectChain(impl: () => Promise<unknown[]>) {
  return () => ({
    from: () => ({
      where: () => ({
        limit: impl,
      }),
    }),
  });
}

/** Build a db.insert(...).values(...).onConflictDoUpdate(...) chain. */
function insertChain(impl: () => Promise<void>) {
  return () => ({
    values: () => ({
      onConflictDoUpdate: impl,
    }),
  });
}

describe("getForecast — cache degradation", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json(fixture));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("falls through to a live fetch when cacheGet throws (M2)", async () => {
    // db.select rejects → cacheGet throws → must still fetch live, not reject.
    vi.mocked(db.select).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      selectChain(() => Promise.reject(new Error("cache read down"))) as any,
    );
    vi.mocked(db.insert).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      insertChain(() => Promise.resolve()) as any,
    );

    const doc = await getForecast("lake-1", 57.7, 13.0);
    expect(Array.isArray(doc.timeSeries)).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("still returns the live doc when cacheSet throws (M2)", async () => {
    // cacheGet returns empty (miss) → fetch live → cacheSet rejects → must
    // still return the fetched doc, not reject.
    vi.mocked(db.select).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      selectChain(() => Promise.resolve([])) as any,
    );
    vi.mocked(db.insert).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      insertChain(() => Promise.reject(new Error("cache write down"))) as any,
    );

    const doc = await getForecast("lake-1", 57.7, 13.0);
    expect(Array.isArray(doc.timeSeries)).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("returns the cached doc without fetching when the cache is fresh", async () => {
    vi.mocked(db.select).mockImplementation(
      selectChain(
        () => Promise.resolve([{ fetchedAt: new Date(), doc: fixture }]),
        // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      ) as any,
    );

    const doc = await getForecast("lake-1", 57.7, 13.0);
    expect(Array.isArray(doc.timeSeries)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getForecast — singleflight dedupe of concurrent cache misses (issue #9)
//
// db.select is driven to always report a cache miss (empty rows) so each call
// takes the fetch path; db.insert (cacheSet) writes are counted. We stub global
// fetch with a deferred Response and count invocations: two concurrent misses
// for the same lake must collapse onto a single SMHI fetch.
// ─────────────────────────────────────────────────────────────────────────────

describe("getForecast singleflight", () => {
  let fetchCalls: number;
  let pending: (() => void)[];
  let insertCalls: number;
  const realFetch = globalThis.fetch;

  // Yield until `count` fetches have parked (getForecast takes several microtask
  // hops — cacheGet, then the fetch itself — before a resolver is registered),
  // then release them all and let the singleflight promises settle and clear
  // their map entries. Polling avoids guessing the exact number of hops.
  const releaseFetches = async (count: number) => {
    for (let i = 0; i < 100 && pending.length < count; i++) {
      await Promise.resolve();
    }
    for (const resolve of pending.splice(0)) resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    fetchCalls = 0;
    pending = [];
    insertCalls = 0;
    // Always a cache miss → every call takes the fetch path.
    vi.mocked(db.select).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      selectChain(() => Promise.resolve([])) as any,
    );
    // Count cacheSet writes to assert a single write per collapsed flight.
    vi.mocked(db.insert).mockImplementation(
      insertChain(() => {
        insertCalls += 1;
        return Promise.resolve();
        // biome-ignore lint/suspicious/noExplicitAny: drizzle chain stub
      }) as any,
    );
    // Each fetch parks on a promise we resolve manually, so concurrent callers
    // are guaranteed to be past cacheGet and into the singleflight check before
    // any fetch settles.
    globalThis.fetch = vi.fn(async () => {
      fetchCalls += 1;
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      return new Response(JSON.stringify(fixtureRaw), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("fires one SMHI fetch for two concurrent misses of the same lake", async () => {
    const a = getForecast("lake-1", 59.3293, 18.0686);
    const b = getForecast("lake-1", 59.3293, 18.0686);

    // Both callers were launched synchronously before either cleared cacheGet,
    // so the second joins the first's in-flight promise — only one fetch parks.
    await releaseFetches(1);

    const [docA, docB] = await Promise.all([a, b]);

    expect(fetchCalls).toBe(1);
    // Both joiners resolve with the same fetched doc, and it was cached once.
    expect(docA).toEqual(docB);
    expect(docA.timeSeries.length).toBe(fixture.timeSeries.length);
    expect(insertCalls).toBe(1);
  });

  it("fires separate fetches for distinct lakes", async () => {
    const a = getForecast("lake-a", 59.3293, 18.0686);
    const b = getForecast("lake-b", 57.7089, 11.9746);

    // Distinct keys never share an in-flight promise — both fetches park.
    await releaseFetches(2);

    await Promise.all([a, b]);

    expect(fetchCalls).toBe(2);
  });

  it("does not leak the in-flight entry — a later miss refetches", async () => {
    const first = getForecast("lake-1", 59.3293, 18.0686);
    await releaseFetches(1);
    await first;
    expect(fetchCalls).toBe(1);

    // The first flight has settled and cleared its map entry, so a fresh miss
    // starts a new fetch rather than joining a stale promise.
    const second = getForecast("lake-1", 59.3293, 18.0686);
    await releaseFetches(1);
    await second;
    expect(fetchCalls).toBe(2);
  });
});
