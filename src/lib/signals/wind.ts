/**
 * Compute the windward (downwind) shore label from a SMHI wind_from_direction bearing.
 *
 * SMHI's `wind_from_direction` is meteorological: it specifies the bearing the wind
 * blows FROM (e.g., 0° = wind from north, blowing south). The windward shore is the
 * shore the wind blows TOWARD, where baitfish and active fish stack—the angler's target.
 *
 * Calculation:
 * 1. Add 180° to the wind-from bearing to find the opposite shore (downwind direction).
 * 2. Normalize to [0, 360) range to handle negative and over-360 values.
 * 3. Convert the bearing to an 8-point compass label.
 *
 * 8-point compass binning (45° per quadrant):
 * - N:  [337.5°, 22.5°)    (blows from S)
 * - NE: [22.5°, 67.5°)     (blows from SW)
 * - E:  [67.5°, 112.5°)    (blows from W)
 * - SE: [112.5°, 157.5°)   (blows from NW)
 * - S:  [157.5°, 202.5°)   (blows from N)
 * - SW: [202.5°, 247.5°)   (blows from NE)
 * - W:  [247.5°, 292.5°)   (blows from E)
 * - NW: [292.5°, 337.5°)   (blows from SE)
 */

/** 8-point compass label of the windward shore. */
export type CompassPoint = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** 16-point compass label — fine-grained enough to angle shore advice. */
export type CompassPoint16 =
  | "N"
  | "NNE"
  | "NE"
  | "ENE"
  | "E"
  | "ESE"
  | "SE"
  | "SSE"
  | "S"
  | "SSW"
  | "SW"
  | "WSW"
  | "W"
  | "WNW"
  | "NW"
  | "NNW";

/**
 * Full wind direction description for the LLM snapshot: both the raw
 * meteorological bearing (blows FROM) and the drift bearing (blows TOWARD),
 * each with a 16-point compass label. The 16-point granularity lets advice
 * angle within a shore (e.g. from WSW → toward ENE → "östra stranden, helst
 * delen som vetter mot nordost") instead of collapsing everything to 8 bins.
 */
export type WindDirection = {
  /** Bearing the wind blows FROM (SMHI convention), normalized to [0, 360). */
  fromDeg: number;
  fromCompass: CompassPoint16;
  /** Bearing the wind blows TOWARD — where surface drift and baitfish pile up. */
  towardDeg: number;
  towardCompass: CompassPoint16;
};

const COMPASS_16: readonly CompassPoint16[] = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

function normalizeBearing(deg: number): number {
  const normalized = deg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

/** Map a bearing to its 16-point compass label (22.5° bins, centered). */
function compass16(bearingDeg: number): CompassPoint16 {
  return COMPASS_16[Math.round(normalizeBearing(bearingDeg) / 22.5) % 16];
}

/**
 * @param windFromDirectionDeg - Wind bearing in degrees, SMHI `wind_from_direction`
 *   convention (0 = wind from north, 270 = wind from west).
 * @throws on non-finite input, same contract as {@link windwardShore} (M6):
 *   callers guard with Number.isFinite and treat a throw as the signal absent.
 */
export function describeWindDirection(
  windFromDirectionDeg: number,
): WindDirection {
  if (!Number.isFinite(windFromDirectionDeg)) {
    throw new Error(
      `describeWindDirection: windFromDirectionDeg must be finite, got ${windFromDirectionDeg}`,
    );
  }
  const fromDeg = normalizeBearing(windFromDirectionDeg);
  const towardDeg = normalizeBearing(fromDeg + 180);
  return {
    fromDeg,
    fromCompass: compass16(fromDeg),
    towardDeg,
    towardCompass: compass16(towardDeg),
  };
}

/**
 * @param windFromDirectionDeg - Wind bearing in degrees (0–360, where 0=N, 90=E, 180=S, 270=W).
 * @returns Compass label of the windward shore (N, NE, E, SE, S, SW, W, NW).
 * @throws if the input is not a finite number — `(NaN + 180) % 360` stays NaN
 *   and would silently fall through to a confident-wrong "N" (M6).  Callers
 *   guard with Number.isFinite and treat a throw as the signal being absent.
 */
export function windwardShore(windFromDirectionDeg: number): CompassPoint {
  if (!Number.isFinite(windFromDirectionDeg)) {
    throw new Error(
      `windwardShore: windFromDirectionDeg must be finite, got ${windFromDirectionDeg}`,
    );
  }
  // Normalize to [0, 360)
  let windTowardDeg = (windFromDirectionDeg + 180) % 360;
  if (windTowardDeg < 0) {
    windTowardDeg += 360;
  }

  // Map bearing to 8-point compass label
  // Each bin is 45° wide, centered on its cardinal/intercardinal
  if (windTowardDeg >= 337.5 || windTowardDeg < 22.5) {
    return "N";
  }
  if (windTowardDeg >= 22.5 && windTowardDeg < 67.5) {
    return "NE";
  }
  if (windTowardDeg >= 67.5 && windTowardDeg < 112.5) {
    return "E";
  }
  if (windTowardDeg >= 112.5 && windTowardDeg < 157.5) {
    return "SE";
  }
  if (windTowardDeg >= 157.5 && windTowardDeg < 202.5) {
    return "S";
  }
  if (windTowardDeg >= 202.5 && windTowardDeg < 247.5) {
    return "SW";
  }
  if (windTowardDeg >= 247.5 && windTowardDeg < 292.5) {
    return "W";
  }
  if (windTowardDeg >= 292.5 && windTowardDeg < 337.5) {
    return "NW";
  }

  // Should never reach here
  return "N";
}
