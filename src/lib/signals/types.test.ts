import { describe, expect, it } from "vitest";
import type { Signals } from "./types";

describe("Signals type", () => {
  it("should allow a Signals object with only required fields", () => {
    const minimalSignals: Signals = {
      lake: "Test Lake",
      lakeId: "test-lake-1",
      timeLocal: "2026-06-29T14:30:00",
    };

    expect(minimalSignals.lakeId).toBe("test-lake-1");
  });
});
