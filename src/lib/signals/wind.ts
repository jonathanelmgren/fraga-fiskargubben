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
 *
 * @param windFromDirectionDeg - Wind bearing in degrees (0–360, where 0=N, 90=E, 180=S, 270=W).
 * @returns Compass label of the windward shore (N, NE, E, SE, S, SW, W, NW).
 */
export function windwardShore(windFromDirectionDeg: number): string {
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
