/**
 * Shared angle conversion helpers (L9).
 *
 * `toRad` was previously redefined in both light.ts and haversine.ts; this is
 * the single shared source of truth.
 */

/** Degrees → radians. */
export const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Radians → degrees. */
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;
