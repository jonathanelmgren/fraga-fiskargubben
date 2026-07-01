import { describe, expect, it } from "vitest";
import { mapDepthRecord } from "./depth";

// ────────────────────────────────────────────────────────────────────────────
// mapDepthRecord — pure mapper unit tests
// ────────────────────────────────────────────────────────────────────────────

describe("mapDepthRecord", () => {
  it("maps a full record with both maxDepth and meanDepth", () => {
    const result = mapDepthRecord({
      lakeId: "SE999999-999999",
      maxDepthM: 42.5,
      meanDepthM: 18.3,
    });
    expect(result.lakeId).toBe("SE999999-999999");
    expect(result.maxDepthM).toBe(42.5);
    expect(result.meanDepthM).toBe(18.3);
  });

  it("maps a record with only maxDepthM — meanDepthM becomes null", () => {
    const result = mapDepthRecord({
      lakeId: "SE111111-111111",
      maxDepthM: 12.0,
    });
    expect(result.lakeId).toBe("SE111111-111111");
    expect(result.maxDepthM).toBe(12.0);
    expect(result.meanDepthM).toBeNull();
  });

  it("maps a record with only meanDepthM — maxDepthM becomes null", () => {
    const result = mapDepthRecord({
      lakeId: "SE222222-222222",
      meanDepthM: 7.1,
    });
    expect(result.lakeId).toBe("SE222222-222222");
    expect(result.maxDepthM).toBeNull();
    expect(result.meanDepthM).toBe(7.1);
  });

  it("maps a record with neither depth field — both become null", () => {
    const result = mapDepthRecord({ lakeId: "SE333333-333333" });
    expect(result.maxDepthM).toBeNull();
    expect(result.meanDepthM).toBeNull();
  });

  it("throws when lakeId is missing", () => {
    expect(() =>
      mapDepthRecord({ maxDepthM: 10, meanDepthM: 5 } as unknown as {
        lakeId: string;
      }),
    ).toThrow(/lakeId/);
  });

  it("throws when lakeId is an empty string", () => {
    expect(() => mapDepthRecord({ lakeId: "", maxDepthM: 10 })).toThrow(
      /lakeId/,
    );
  });

  it("preserves zero depth correctly (0 m max is valid)", () => {
    const result = mapDepthRecord({ lakeId: "SE444444-444444", maxDepthM: 0 });
    expect(result.maxDepthM).toBe(0);
  });

  it("throws when maxDepthM is non-finite (NaN)", () => {
    expect(() =>
      mapDepthRecord({ lakeId: "SE555555-555555", maxDepthM: Number.NaN }),
    ).toThrow(/maxDepthM/);
  });

  it("throws when meanDepthM is non-finite (Infinity)", () => {
    expect(() =>
      mapDepthRecord({
        lakeId: "SE666666-666666",
        meanDepthM: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/meanDepthM/);
  });
});
