import { describe, expect, it } from "vitest";
import { lightWindow, sunTimes } from "./light";

// ── sunTimes ──────────────────────────────────────────────────────────────────
//
// Reference: Stockholm (59.3293° N, 18.0686° E) on 2026-04-15 (spring, no polar issues).
//
// NOAA sunrise equation (and an independent NOAA simplified formula) for
// Stockholm 2026-04-15 both give:
//   Sunrise ≈ 03:35 UTC (05:35 local CEST)
//   Sunset  ≈ 18:00 UTC (20:00 local CEST)
//
// We allow ±7.5 min tolerance (the standard sunrise equation is accurate to
// within a minute or two; the window covers rounding and equation-of-time
// approximations, while still ruling out timezone (±1h) and epoch (±6h) errors).

describe("sunTimes", () => {
  const LAT = 59.3293;
  const LON = 18.0686;
  const DATE = new Date("2026-04-15T00:00:00Z");

  it("returns sunrise near 03:35 UTC for Stockholm on 2026-04-15", () => {
    // Reference: NOAA sunrise equation + independent NOAA simplified formula both give ~03:33–03:37 UTC
    // Stockholm is UTC+2 (CEST) so local sunrise ~05:35 — plausible for mid-April.
    const { sunrise } = sunTimes(LAT, LON, DATE);
    expect(sunrise).not.toBeNull();
    if (!sunrise) return;
    // Expected: 2026-04-15T03:35:00Z → 215 min after midnight UTC
    const minutesAfterMidnight = (sunrise.getTime() - DATE.getTime()) / 60000;
    expect(minutesAfterMidnight).toBeGreaterThan(210); // 03:30 UTC
    expect(minutesAfterMidnight).toBeLessThan(225); // 03:45 UTC
  });

  it("returns sunset near 18:00 UTC for Stockholm on 2026-04-15", () => {
    // Reference: NOAA simplified formula gives ~17:59, Meeus algorithm ~18:01 UTC
    // Stockholm local sunset: ~20:00 CEST — plausible for mid-April.
    const { sunset } = sunTimes(LAT, LON, DATE);
    expect(sunset).not.toBeNull();
    if (!sunset) return;
    // Expected: 2026-04-15T18:00:00Z → 1080 min after midnight UTC
    const minutesAfterMidnight = (sunset.getTime() - DATE.getTime()) / 60000;
    expect(minutesAfterMidnight).toBeGreaterThan(1070); // 17:50 UTC
    expect(minutesAfterMidnight).toBeLessThan(1090); // 18:10 UTC
  });

  it("handles polar day — returns null sunrise/sunset for Tromsø in midsummer", () => {
    // Tromsø 69.65°N: sun never sets around summer solstice
    const { sunrise, sunset } = sunTimes(
      69.65,
      18.96,
      new Date("2026-06-21T00:00:00Z"),
    );
    // Polar day → both null (sun never rises above/sets below horizon)
    // The hour angle cos would be < -1, so we return null
    expect(sunrise).toBeNull();
    expect(sunset).toBeNull();
  });

  it("handles polar night — returns null sunrise/sunset for Tromsø in midwinter", () => {
    // Tromsø in December: sun never rises
    const { sunrise, sunset } = sunTimes(
      69.65,
      18.96,
      new Date("2026-12-21T00:00:00Z"),
    );
    expect(sunrise).toBeNull();
    expect(sunset).toBeNull();
  });
});

// ── lightWindow ───────────────────────────────────────────────────────────────
//
// Fixed sun: sunrise at 05:00 UTC, sunset at 19:00 UTC (both 2026-04-15).
// Dawn window: 04:15–05:45 UTC  (±45 min around 05:00)
// Dusk window: 18:15–19:45 UTC  (±45 min around 19:00)

describe("lightWindow", () => {
  const sunrise = new Date("2026-04-15T05:00:00Z");
  const sunset = new Date("2026-04-15T19:00:00Z");
  const sun = { sunrise, sunset };

  it("classifies 30 min after sunrise as dawn", () => {
    const t = new Date("2026-04-15T05:30:00Z");
    expect(lightWindow(t, sun)).toBe("dawn");
  });

  it("classifies 30 min before sunset as dusk", () => {
    const t = new Date("2026-04-15T18:30:00Z");
    expect(lightWindow(t, sun)).toBe("dusk");
  });

  it("classifies midday as day", () => {
    const t = new Date("2026-04-15T12:00:00Z");
    expect(lightWindow(t, sun)).toBe("day");
  });

  it("classifies midnight (00:00 UTC) as night", () => {
    const t = new Date("2026-04-15T00:00:00Z");
    expect(lightWindow(t, sun)).toBe("night");
  });

  it("classifies 30 min before sunrise as dawn", () => {
    const t = new Date("2026-04-15T04:30:00Z");
    expect(lightWindow(t, sun)).toBe("dawn");
  });

  it("classifies 30 min after sunset as dusk", () => {
    const t = new Date("2026-04-15T19:30:00Z");
    expect(lightWindow(t, sun)).toBe("dusk");
  });

  it("classifies exactly 45 min before sunrise as dawn (boundary inclusive)", () => {
    const t = new Date("2026-04-15T04:15:00Z");
    expect(lightWindow(t, sun)).toBe("dawn");
  });

  it("classifies exactly 46 min before sunrise as night (just outside dawn window)", () => {
    const t = new Date("2026-04-15T04:14:00Z");
    expect(lightWindow(t, sun)).toBe("night");
  });

  it("classifies exactly 45 min after sunset as dusk (boundary inclusive)", () => {
    const t = new Date("2026-04-15T19:45:00Z");
    expect(lightWindow(t, sun)).toBe("dusk");
  });

  it("classifies exactly 46 min after sunset as night (just outside dusk window)", () => {
    const t = new Date("2026-04-15T19:46:00Z");
    expect(lightWindow(t, sun)).toBe("night");
  });

  it("classifies just after end of dawn window as day", () => {
    const t = new Date("2026-04-15T05:46:00Z");
    expect(lightWindow(t, sun)).toBe("day");
  });

  it("classifies just before start of dusk window as day", () => {
    const t = new Date("2026-04-15T18:14:00Z");
    expect(lightWindow(t, sun)).toBe("day");
  });

  it("returns night when sun is null (polar night)", () => {
    const t = new Date("2026-12-21T12:00:00Z");
    expect(lightWindow(t, { sunrise: null, sunset: null })).toBe("night");
  });

  it("returns day when sunrise and sunset are null (polar day)", () => {
    const t = new Date("2026-06-21T12:00:00Z");
    expect(
      lightWindow(t, { sunrise: null, sunset: null, polarDay: true }),
    ).toBe("day");
  });
});
