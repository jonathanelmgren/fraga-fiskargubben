export type Source = "forecast" | "observed" | "modeled" | "estimated";
export type Provenance = { source: Source; confidence: "high" | "low" };
export type WithProvenance<T> = { value: T; provenance: Provenance };

export type Signals = {
  lake: string; // Lake label
  lakeId: string;
  timeLocal: string; // ISO local Target time
  airTempC?: WithProvenance<number>;
  pressureHpa?: WithProvenance<number>;
  pressureTrend?: WithProvenance<"rising" | "falling" | "stable">;
  airTempTrend5d?: WithProvenance<"warming" | "cooling" | "steady">;
  windMs?: WithProvenance<number>;
  windwardShore?: WithProvenance<string>; // compass label
  cloudPct?: WithProvenance<number>;
  waterTempC?: WithProvenance<number>;
  waterColour?: WithProvenance<"brown" | "clear">;
  sightDepthM?: WithProvenance<number>;
  maxDepthM?: WithProvenance<number>;
  lightWindow?: "dawn" | "day" | "dusk" | "night";
  speciesPresent?: string[];
  speciesComfort?: Record<string, "comfortable" | "sluggish">;
};
