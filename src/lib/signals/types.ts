export type Source = "forecast" | "observed" | "modeled" | "estimated";

/**
 * What kind of water (or place) the user named, as classified by the
 * extractor. "sjö" is the only kind the lake register can resolve; the rest
 * short-circuit to area mode. The extractor is instructed to default to
 * "sjö" on any doubt so a resolvable lake is never misrouted.
 */
export type WaterKind = "sjö" | "älv" | "kust" | "ort" | "annat";
export type Provenance = { source: Source; confidence: "high" | "low" };
export type WithProvenance<T> = { value: T; provenance: Provenance };

export type Signals = {
  lake: string; // Lake label — canonical "name (municipality, county)" format
  lakeId: string;
  /**
   * Rebuild: set when the lake could not be resolved and the conversation
   * continues in area mode — the snapshot then carries only SMHI-derived
   * conditions (no lake-specific water data). The persona is instructed to be
   * honest about not knowing the specific water. `lakeId` is "area" and
   * `lake` is an area label ("trakten kring …").
   */
  areaOnly?: boolean;
  /** Area mode: the water name the user asked about, so the answer can name it honestly. */
  askedLakeName?: string;
  /**
   * Area mode: what kind of water askedLakeName is (extractor guess). Lets
   * the persona say "älven"/"kusten" instead of assuming everything is a
   * lake ("en sjö kallad Kalmar"). Absent on old snapshots and when the
   * extractor did not classify.
   */
  askedWaterKind?: WaterKind;
  /**
   * Area mode with a known user location: the nearest named lakes from the
   * register, so "vilken sjö nära mig?" gets real suggestions instead of a
   * shrug. Names/distances only — no depth/species data, and the persona is
   * instructed not to invent any.
   */
  nearbyLakes?: Array<{
    name: string;
    municipality: string;
    distanceKm?: number;
    areaHa: number;
  }>;
  /**
   * Bare lake name (e.g. "Tolken") without the municipality/county suffix.
   * Used internally for the lake-lock comparison so the lock is not coupled
   * to the formatted label.  Absent on old snapshots (treat as undefined).
   */
  bareLakeName?: string;
  timeLocal: string; // ISO local Target time
  /**
   * #8: when conditions come from OBSERVED data (past target) and the nearest
   * available observation is far from the requested time, this holds that
   * offset in minutes.  The observed condition Signals (airTempC/pressureHpa/
   * windMs) are additionally downgraded to "low" confidence.  Absent when
   * conditions are from the forecast path or the nearest obs is close to
   * target — the LLM should hedge ("närmaste mätning var N h från …") only
   * when this is present.
   */
  conditionsStaleMinutes?: number;
  airTempC?: WithProvenance<number>;
  pressureHpa?: WithProvenance<number>;
  pressureTrend?: WithProvenance<"rising" | "falling" | "stable">;
  airTempTrend5d?: WithProvenance<"warming" | "cooling" | "steady">;
  windMs?: WithProvenance<number>;
  windwardShore?: WithProvenance<string>; // compass label
  /**
   * Full wind direction (degrees + 16-point compass, both FROM and TOWARD).
   * SMHI reports the bearing wind blows FROM; the persona is instructed that
   * towardCompass is the shore where drift and baitfish collect, with 16-point
   * granularity for angled advice ("östra stranden, delen mot nordost").
   * Absent on old snapshots — windwardShore alone then carries the shore.
   */
  windDirection?: WithProvenance<{
    fromDeg: number;
    fromCompass: string;
    towardDeg: number;
    towardCompass: string;
  }>;
  /** Cloud cover in percent (0 = clear, 100 = overcast). SMHI reports octas; converted at build. */
  cloudPct?: WithProvenance<number>;
  /**
   * Mean precipitation in mm/h at the target time (forecast path only — the
   * observed metobs path has no precipitation parameter, so the field is
   * simply absent for past targets).
   */
  precipMmH?: WithProvenance<number>;
  /** Max wind gust in m/s at the target time (forecast path only). */
  windGustMs?: WithProvenance<number>;
  /** Thunderstorm probability in percent, 0–100 (forecast path only). */
  thunderPct?: WithProvenance<number>;
  /** Horizontal visibility in air, km (forecast path only). */
  visibilityKm?: WithProvenance<number>;
  waterTempC?: WithProvenance<number>;
  waterColour?: WithProvenance<"brown" | "clear">;
  sightDepthM?: WithProvenance<number>;
  maxDepthM?: WithProvenance<number>;
  lightWindow?: "dawn" | "day" | "dusk" | "night";
  speciesPresent?: string[];
  speciesComfort?: Record<string, "comfortable" | "sluggish">;
};
