/**
 * stockholm.test.ts — Europe/Stockholm wall-clock helpers.
 *
 * The whole point of these helpers is to be independent of the process TZ, so
 * every assertion is written against fixed UTC instants with a known Swedish
 * wall-clock. Run under any TZ (vitest is invoked with TZ=UTC in CI) they must
 * give the same result.
 */

import { describe, expect, it } from "vitest";
import {
  formatStockholmLocal,
  stockholmOffsetMinutes,
  stockholmParts,
  stockholmWallClockToUtc,
} from "./stockholm";

describe("stockholmParts", () => {
  it("decomposes a summer (CEST, +2) instant into Swedish wall-clock", () => {
    // 2026-07-02T22:10:00Z === 2026-07-03 00:10 in Stockholm.
    const p = stockholmParts(new Date("2026-07-02T22:10:00Z"));
    expect(p).toMatchObject({
      year: 2026,
      month: 7,
      day: 3,
      hour: 0,
      minute: 10,
      weekday: 5, // Friday
    });
  });

  it("decomposes a winter (CET, +1) instant", () => {
    // 2026-01-15T23:30:00Z === 2026-01-16 00:30 in Stockholm.
    const p = stockholmParts(new Date("2026-01-15T23:30:00Z"));
    expect(p).toMatchObject({
      year: 2026,
      month: 1,
      day: 16,
      hour: 0,
      minute: 30,
    });
  });

  it("normalises midnight to hour 0 (not 24)", () => {
    // 2026-06-30T22:00:00Z === 2026-07-01 00:00 Stockholm.
    expect(stockholmParts(new Date("2026-06-30T22:00:00Z")).hour).toBe(0);
  });
});

describe("formatStockholmLocal", () => {
  it("renders the Swedish wall-clock, NOT UTC (regression for the timeLocal bug)", () => {
    // The exact reported case: asked at 00:10 Swedish summer. toISOString() would
    // give 22:10 — the bug that made the persona say 'klockan tio på kvällen'.
    expect(formatStockholmLocal(new Date("2026-07-02T22:10:00Z"))).toBe(
      "2026-07-03T00:10:00",
    );
  });

  it("has no zone suffix (it is zone-less local time)", () => {
    expect(formatStockholmLocal(new Date("2026-07-02T22:10:00Z"))).not.toMatch(
      /[Zz]$/,
    );
  });
});

describe("stockholmOffsetMinutes", () => {
  it("is +120 during CEST (summer)", () => {
    expect(stockholmOffsetMinutes(new Date("2026-07-01T12:00:00Z"))).toBe(120);
  });

  it("is +60 during CET (winter)", () => {
    expect(stockholmOffsetMinutes(new Date("2026-01-01T12:00:00Z"))).toBe(60);
  });
});

describe("stockholmWallClockToUtc", () => {
  it("round-trips a summer wall-clock to the correct UTC instant", () => {
    const utc = stockholmWallClockToUtc({
      year: 2026,
      month: 7,
      day: 3,
      hour: 19,
      minute: 0,
    });
    // 19:00 CEST = 17:00 UTC.
    expect(utc.toISOString()).toBe("2026-07-03T17:00:00.000Z");
    // …and rendering it back gives the same wall-clock.
    expect(formatStockholmLocal(utc)).toBe("2026-07-03T19:00:00");
  });

  it("round-trips a winter wall-clock (CET, +1)", () => {
    const utc = stockholmWallClockToUtc({
      year: 2026,
      month: 1,
      day: 16,
      hour: 19,
      minute: 0,
    });
    // 19:00 CET = 18:00 UTC.
    expect(utc.toISOString()).toBe("2026-01-16T18:00:00.000Z");
    expect(formatStockholmLocal(utc)).toBe("2026-01-16T19:00:00");
  });
});
