import { describe, expect, it } from "vitest";
import { octasToPercent, probabilityPct } from "./units";

describe("octasToPercent", () => {
  it("0 octas → 0% (clear sky)", () => {
    expect(octasToPercent(0)).toBe(0);
  });

  it("8 octas → 100% (fully overcast — the 'nästan molnfritt' bug case)", () => {
    expect(octasToPercent(8)).toBe(100);
  });

  it("4 octas → 50%", () => {
    expect(octasToPercent(4)).toBe(50);
  });

  it("3 octas → 38% (rounded)", () => {
    expect(octasToPercent(3)).toBe(38);
  });

  it("clamps out-of-range values", () => {
    expect(octasToPercent(9)).toBe(100);
    expect(octasToPercent(-1)).toBe(0);
  });

  it("passes through absence: undefined/NaN → undefined", () => {
    expect(octasToPercent(undefined)).toBeUndefined();
    expect(octasToPercent(Number.NaN)).toBeUndefined();
  });
});

describe("probabilityPct", () => {
  it("passes valid probabilities through", () => {
    expect(probabilityPct(0)).toBe(0);
    expect(probabilityPct(37)).toBe(37);
    expect(probabilityPct(100)).toBe(100);
  });

  it("negative sentinel (-9) → undefined, not a confusing negative", () => {
    expect(probabilityPct(-9)).toBeUndefined();
  });

  it("clamps over-100 to 100", () => {
    expect(probabilityPct(105)).toBe(100);
  });

  it("passes through absence: undefined/NaN → undefined", () => {
    expect(probabilityPct(undefined)).toBeUndefined();
    expect(probabilityPct(Number.NaN)).toBeUndefined();
  });
});
