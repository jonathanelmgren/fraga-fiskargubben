/**
 * Species comfort rules: classifies Swedish lake/river fish species as
 * "comfortable" or "sluggish" based on water temperature.
 *
 * DESIGN DECISION: unknown species are OMITTED from the result. We only emit
 * flags where we have a documented rule — no invented defaults for species we
 * know nothing about.
 *
 * These thresholds are approximate fishing heuristics, not precise biology.
 * Sources of judgment: Swedish fishing guides, SLU (Aqua) thermal preference
 * data, and standard sport-fishing literature. All thresholds are approximate
 * (±1-2°C should be considered equivalent). v1 uses water temperature only;
 * season is not modelled (future work if needed).
 *
 * THRESHOLD INCLUSIVITY: the upper heat threshold is EXCLUSIVE (> N is
 * sluggish; exactly N is comfortable). Cold-floor thresholds (gös) are also
 * exclusive (< N is sluggish; exactly N is comfortable). This mirrors how
 * these heuristics are typically stated ("above ~X°C").
 */

type Comfort = "comfortable" | "sluggish";

/**
 * A rule is a function that takes waterTempC and returns a Comfort
 * classification for that species.
 */
type ComfortRule = (waterTempC: number) => Comfort;

/**
 * Rules table for common Swedish lake species (Swedish names, matching the
 * species ETL).
 *
 * gädda  (pike)   — cold-water ambush predator. Optimal range ~10–18°C.
 *                   Holds deep / goes lethargic in summer heat above ~21°C.
 *                   Source: SLU Aqua thermal tolerance data; "Fiskeboken".
 *
 * abborre (perch)  — more eurythermal than pike but still a cool-water fish.
 *                   Active well into mid-20s; noticeably sluggish above ~24°C.
 *                   Source: standard Nordic fishing literature.
 *
 * gös    (zander/pikeperch) — warm-water tolerant, thrives ~16–24°C.
 *                   Sluggish in very cold water (< 6°C, pre-spawn coma) and
 *                   in extreme heat (> 26°C). Source: SLU Aqua; IGFA records.
 *
 * öring  (brown trout) — obligate cold-water salmonid. Optimal ~8–16°C.
 *                   Stress and lethargy set in above ~18°C; mortality risk > 22°C.
 *                   Source: Hyvärinen & Vehanen (2004); Naturvårdsverket.
 *
 * lax    (Atlantic salmon) — same cold-water family as öring, very similar
 *                   thermal preference. Sluggish above ~18°C.
 *                   Source: ICES salmon temperature guidance.
 *
 * mört   (roach)   — hardy cyprinid, broadly eurythermal (4–28°C active).
 *                   Sluggish only in extreme summer heat above ~28°C.
 *                   Source: FishBase; Swedish freshwater fishing notes.
 *
 * braxen (bream)   — another robust cyprinid. Similar range to mört.
 *                   Sluggish only above ~28°C. Source: FishBase.
 */
const RULES: Record<string, ComfortRule> = {
  gädda: (t) => (t > 21 ? "sluggish" : "comfortable"),
  abborre: (t) => (t > 24 ? "sluggish" : "comfortable"),
  gös: (t) => (t < 6 || t > 26 ? "sluggish" : "comfortable"),
  öring: (t) => (t > 18 ? "sluggish" : "comfortable"),
  lax: (t) => (t > 18 ? "sluggish" : "comfortable"),
  mört: (t) => (t > 28 ? "sluggish" : "comfortable"),
  braxen: (t) => (t > 28 ? "sluggish" : "comfortable"),
};

/**
 * Classifies each species in speciesPresent as "comfortable" or "sluggish"
 * for the given water temperature.
 *
 * @param speciesPresent - Swedish species names (e.g. ["gädda", "abborre"]).
 * @param waterTempC     - Surface water temperature in Celsius. Must be finite.
 * @returns A Record mapping each recognised species to its comfort level.
 *          Species not in the rules table are omitted entirely.
 */
export function speciesComfort(
  speciesPresent: string[],
  waterTempC: number,
): Record<string, Comfort> {
  if (!Number.isFinite(waterTempC)) {
    return {};
  }

  const result: Record<string, Comfort> = {};

  for (const species of speciesPresent) {
    const rule = RULES[species];
    if (rule !== undefined) {
      result[species] = rule(waterTempC);
    }
    // unknown species → omitted (no invented default)
  }

  return result;
}
