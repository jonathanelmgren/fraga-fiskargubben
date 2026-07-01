/**
 * light.ts — sun times and light-window classification
 *
 * Algorithm: NOAA sunrise equation (Jean Meeus, "Astronomical Algorithms", 2nd ed.)
 *   — solar declination, equation of time, solar noon, hour angle for −0.833° zenith
 *   — accurate to within ±1–2 min for mid-latitudes; slightly less at high latitudes
 *
 * Polar edge-case handling:
 *   When the cos(hour-angle) falls outside [−1, 1], the sun never crosses the
 *   −0.833° zenith. We return { sunrise: null, sunset: null } with an additional
 *   `polarDay` boolean. Callers should treat null sunrise/sunset as:
 *     - polarDay === true  → classify as "day" (sun never sets)
 *     - polarDay === false → classify as "night" (sun never rises)
 *   No exception is thrown; the function always returns an object.
 *
 * Dawn/dusk window constant:
 *   WINDOW_MINUTES = 45 minutes either side of sunrise/sunset.
 *   This matches the "prime windows" described in CONTEXT: Light window.
 */

import { toDeg, toRad } from "@/lib/geo/angle";

/** Minutes of the dawn/dusk window on each side of sunrise/sunset (L9). */
const WINDOW_MINUTES = 45;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;

/** Earth's axial obliquity (degrees), J2000 epoch — used for declination. */
const OBLIQUITY_DEG = 23.4397;
/**
 * Sunrise/sunset zenith angle (degrees below horizon): -0.833° accounts for
 * atmospheric refraction (~34′) plus the solar disk's semidiameter (~16′).
 */
const SUNRISE_ZENITH_DEG = -0.833;

export type SunTimes =
  | { sunrise: Date; sunset: Date; polarDay?: undefined }
  | { sunrise: null; sunset: null; polarDay: boolean };

/**
 * Compute sunrise and sunset (UTC) for a given latitude, longitude, and date.
 *
 * @param lat  - latitude in decimal degrees (north positive)
 * @param lon  - longitude in decimal degrees (east positive)
 * @param date - any Date whose UTC calendar date is used (time-of-day ignored)
 * @returns    SunTimes — { sunrise, sunset } or { sunrise: null, sunset: null, polarDay }
 */
export function sunTimes(lat: number, lon: number, date: Date): SunTimes {
  // Julian Day at UTC midnight for this date (from Unix epoch: JD 2440587.5 = 1970-01-01T00:00:00Z)
  const jdMidnight = date.getTime() / 86400000 + 2440587.5;

  // n = integer number of days since J2000.0 noon (2451545.0)
  // Per the Wikipedia sunrise equation, n = ceil(jdMidnight − 2451545.0 + 0.0008)
  const n = Math.ceil(jdMidnight - 2451545.0 + 0.0008);
  const Jstar = n - lon / 360.0; // mean solar noon (Julian day)

  // Solar mean anomaly (degrees, normalised to [0, 360))
  const M = (((357.5291 + 0.98560028 * Jstar) % 360) + 360) % 360;

  // Equation of centre
  const C =
    1.9148 * Math.sin(toRad(M)) +
    0.02 * Math.sin(toRad(2 * M)) +
    0.0003 * Math.sin(toRad(3 * M));

  // Ecliptic longitude of the sun (normalised to [0, 360))
  const lambda = (((M + C + 180 + 102.9372) % 360) + 360) % 360;

  // Solar transit (Julian day at solar noon)
  const Jtransit =
    2451545.0 +
    Jstar +
    0.0053 * Math.sin(toRad(M)) -
    0.0069 * Math.sin(toRad(2 * lambda));

  // Solar declination
  const sinDec = Math.sin(toRad(lambda)) * Math.sin(toRad(OBLIQUITY_DEG));
  const dec = Math.asin(sinDec); // radians

  // Hour angle for the sunrise zenith (atmospheric refraction + solar disk)
  const zenith = SUNRISE_ZENITH_DEG;
  const cosH =
    (Math.sin(toRad(zenith)) - Math.sin(toRad(lat)) * sinDec) /
    (Math.cos(toRad(lat)) * Math.cos(dec));

  // Polar day (cosH < −1) or polar night (cosH > 1)
  if (!Number.isFinite(cosH) || cosH < -1) {
    return { sunrise: null, sunset: null, polarDay: true };
  }
  if (cosH > 1) {
    return { sunrise: null, sunset: null, polarDay: false };
  }

  const H = toDeg(Math.acos(cosH)); // degrees

  // Julian day of sunrise / sunset
  const Jrise = Jtransit - H / 360.0;
  const Jset = Jtransit + H / 360.0;

  // Convert Julian day → Unix ms
  const jdToMs = (jd: number) => (jd - 2440587.5) * 86400000;

  return {
    sunrise: new Date(jdToMs(Jrise)),
    sunset: new Date(jdToMs(Jset)),
  };
}

export type SunTimesInput =
  | { sunrise: Date; sunset: Date; polarDay?: undefined }
  | { sunrise: null; sunset: null; polarDay?: boolean };

/**
 * Classify a target instant relative to the given sun times.
 *
 * Window constant: WINDOW_MINUTES = 45 min either side of sunrise/sunset.
 *
 * Classification priority (checked in order):
 *   1. within [sunrise − 45 min, sunrise + 45 min] → "dawn"
 *   2. within [sunset  − 45 min, sunset  + 45 min] → "dusk"
 *   3. between end of dawn window and start of dusk window → "day"
 *   4. otherwise → "night"
 *
 * Polar cases:
 *   - polarDay (sunrise/sunset null, polarDay true)  → "day"
 *   - polar night (sunrise/sunset null, polarDay falsy) → "night"
 */
export function lightWindow(
  targetTime: Date,
  sun: SunTimesInput,
): "dawn" | "day" | "dusk" | "night" {
  const { sunrise, sunset } = sun;

  // Polar cases — sun never crosses the horizon
  if (sunrise === null || sunset === null) {
    return sun.polarDay === true ? "day" : "night";
  }

  const t = targetTime.getTime();
  const rise = sunrise.getTime();
  const set = sunset.getTime();

  // Dawn window: [sunrise − WINDOW_MS, sunrise + WINDOW_MS]
  if (t >= rise - WINDOW_MS && t <= rise + WINDOW_MS) {
    return "dawn";
  }

  // Dusk window: [sunset − WINDOW_MS, sunset + WINDOW_MS]
  if (t >= set - WINDOW_MS && t <= set + WINDOW_MS) {
    return "dusk";
  }

  // Day: after end of dawn window, before start of dusk window
  if (t > rise + WINDOW_MS && t < set - WINDOW_MS) {
    return "day";
  }

  // Night: before dawn window or after dusk window
  return "night";
}
