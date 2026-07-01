import { describe, expect, it } from "vitest";
import { speciesComfort } from "./species-comfort";

describe("speciesComfort", () => {
  // --- gädda (pike): sluggish when waterTempC > 21 (exclusive threshold) ---
  it("gädda at 16°C → comfortable", () => {
    expect(speciesComfort(["gädda"], 16)).toEqual({ gädda: "comfortable" });
  });

  it("gädda at 21°C (exactly at threshold) → comfortable", () => {
    // threshold is exclusive: > 21 is sluggish, = 21 is comfortable
    expect(speciesComfort(["gädda"], 21)).toEqual({ gädda: "comfortable" });
  });

  it("gädda at 21.1°C → sluggish", () => {
    expect(speciesComfort(["gädda"], 21.1)).toEqual({ gädda: "sluggish" });
  });

  it("gädda at 23°C → sluggish", () => {
    expect(speciesComfort(["gädda"], 23)).toEqual({ gädda: "sluggish" });
  });

  // --- abborre (perch): sluggish when waterTempC > 24 ---
  it("abborre at 23°C → comfortable", () => {
    expect(speciesComfort(["abborre"], 23)).toEqual({ abborre: "comfortable" });
  });

  it("abborre at 24°C (exactly at threshold) → comfortable", () => {
    expect(speciesComfort(["abborre"], 24)).toEqual({ abborre: "comfortable" });
  });

  it("abborre at 26°C → sluggish", () => {
    expect(speciesComfort(["abborre"], 26)).toEqual({ abborre: "sluggish" });
  });

  // --- gös (zander): sluggish when waterTempC > 26 OR < 6 ---
  it("gös at 10°C → comfortable", () => {
    expect(speciesComfort(["gös"], 10)).toEqual({ gös: "comfortable" });
  });

  it("gös at 20°C → comfortable", () => {
    expect(speciesComfort(["gös"], 20)).toEqual({ gös: "comfortable" });
  });

  it("gös at 5°C → sluggish (too cold)", () => {
    expect(speciesComfort(["gös"], 5)).toEqual({ gös: "sluggish" });
  });

  it("gös at 28°C → sluggish (too warm)", () => {
    expect(speciesComfort(["gös"], 28)).toEqual({ gös: "sluggish" });
  });

  // --- öring (trout): sluggish when waterTempC > 18 ---
  it("öring at 15°C → comfortable", () => {
    expect(speciesComfort(["öring"], 15)).toEqual({ öring: "comfortable" });
  });

  it("öring at 20°C → sluggish", () => {
    expect(speciesComfort(["öring"], 20)).toEqual({ öring: "sluggish" });
  });

  // --- lax (salmon): same cold-water rule as öring, sluggish when > 18 ---
  it("lax at 17°C → comfortable", () => {
    expect(speciesComfort(["lax"], 17)).toEqual({ lax: "comfortable" });
  });

  it("lax at 19°C → sluggish", () => {
    expect(speciesComfort(["lax"], 19)).toEqual({ lax: "sluggish" });
  });

  // --- mört (roach): broadly comfortable, sluggish only when > 28 ---
  it("mört at 25°C → comfortable", () => {
    expect(speciesComfort(["mört"], 25)).toEqual({ mört: "comfortable" });
  });

  it("mört at 29°C → sluggish", () => {
    expect(speciesComfort(["mört"], 29)).toEqual({ mört: "sluggish" });
  });

  // --- braxen (bream): hardy cyprinid, sluggish only when > 28 ---
  it("braxen at 27°C → comfortable", () => {
    expect(speciesComfort(["braxen"], 27)).toEqual({ braxen: "comfortable" });
  });

  it("braxen at 30°C → sluggish", () => {
    expect(speciesComfort(["braxen"], 30)).toEqual({ braxen: "sluggish" });
  });

  // --- unknown species → omitted from result ---
  it("unknown species 'sutare' → omitted", () => {
    expect(speciesComfort(["sutare"], 20)).toEqual({});
  });

  it("mix of known and unknown → only known species emitted", () => {
    const result = speciesComfort(["gädda", "sutare"], 16);
    expect(result).toEqual({ gädda: "comfortable" });
    expect("sutare" in result).toBe(false);
  });

  // --- empty input → empty result ---
  it("empty speciesPresent → empty result", () => {
    expect(speciesComfort([], 15)).toEqual({});
  });

  // --- multiple species at once ---
  it("gädda + abborre at 22°C → gädda sluggish, abborre comfortable", () => {
    expect(speciesComfort(["gädda", "abborre"], 22)).toEqual({
      gädda: "sluggish",
      abborre: "comfortable",
    });
  });
});
