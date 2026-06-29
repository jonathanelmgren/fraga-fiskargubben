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
import {
  classifyPressureTrend,
  classifyTempTrend,
  tempConfidence,
} from "./metobs";

// ─────────────────────────────────────────────────────────────────────────────
// classifyPressureTrend — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyPressureTrend", () => {
  it("returns 'stable' when delta is exactly 0", () => {
    expect(classifyPressureTrend(0)).toBe("stable");
  });

  it("returns 'stable' when delta is within threshold (< 1.5 hPa)", () => {
    expect(classifyPressureTrend(1.4)).toBe("stable");
    expect(classifyPressureTrend(-1.4)).toBe("stable");
  });

  it("returns 'stable' when delta is exactly at threshold boundary (1.5 hPa exclusive)", () => {
    // |Δ| < 1.5 → stable; 1.5 itself is NOT stable
    expect(classifyPressureTrend(1.49)).toBe("stable");
    expect(classifyPressureTrend(-1.49)).toBe("stable");
  });

  it("returns 'rising' when delta >= 1.5 hPa", () => {
    expect(classifyPressureTrend(1.5)).toBe("rising");
    expect(classifyPressureTrend(3.0)).toBe("rising");
    expect(classifyPressureTrend(10.0)).toBe("rising");
  });

  it("returns 'falling' when delta <= -1.5 hPa", () => {
    expect(classifyPressureTrend(-1.5)).toBe("falling");
    expect(classifyPressureTrend(-3.0)).toBe("falling");
    expect(classifyPressureTrend(-10.0)).toBe("falling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyTempTrend — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyTempTrend", () => {
  it("returns 'steady' when delta is exactly 0", () => {
    expect(classifyTempTrend(0)).toBe("steady");
  });

  it("returns 'steady' when delta is within threshold (< 2 °C)", () => {
    expect(classifyTempTrend(1.9)).toBe("steady");
    expect(classifyTempTrend(-1.9)).toBe("steady");
  });

  it("returns 'steady' when delta is just below threshold boundary", () => {
    expect(classifyTempTrend(1.99)).toBe("steady");
    expect(classifyTempTrend(-1.99)).toBe("steady");
  });

  it("returns 'warming' when delta >= 2 °C", () => {
    expect(classifyTempTrend(2.0)).toBe("warming");
    expect(classifyTempTrend(5.0)).toBe("warming");
    expect(classifyTempTrend(15.0)).toBe("warming");
  });

  it("returns 'cooling' when delta <= -2 °C", () => {
    expect(classifyTempTrend(-2.0)).toBe("cooling");
    expect(classifyTempTrend(-5.0)).toBe("cooling");
    expect(classifyTempTrend(-15.0)).toBe("cooling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tempConfidence — pure unit tests (ADR-0002, spec §3 >40 km → low)
// ─────────────────────────────────────────────────────────────────────────────

describe("tempConfidence", () => {
  it("returns 'high' when distance is 0 km", () => {
    expect(tempConfidence(0)).toBe("high");
  });

  it("returns 'high' when distance is well under 40 km", () => {
    expect(tempConfidence(10)).toBe("high");
    expect(tempConfidence(25)).toBe("high");
    expect(tempConfidence(39.9)).toBe("high");
  });

  it("returns 'high' when distance is exactly 40 km (boundary: ≤ 40 is high)", () => {
    expect(tempConfidence(40)).toBe("high");
  });

  it("returns 'low' when distance is just over 40 km", () => {
    expect(tempConfidence(40.1)).toBe("low");
  });

  it("returns 'low' when distance is well over 40 km", () => {
    expect(tempConfidence(60)).toBe("low");
    expect(tempConfidence(200)).toBe("low");
  });
});
