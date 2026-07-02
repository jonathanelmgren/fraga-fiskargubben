/**
 * SWEREF99TM (EPSG:3006) → WGS84 (EPSG:4326) coordinate transform.
 *
 * SWEREF99TM is a Transverse Mercator projection on the GRS80 ellipsoid, used
 * by SLU/MVM/NORS for station and sample-site coordinates. The lakes centroids
 * and the runtime are WGS84, so import-time station→lake joins must reproject
 * SWEREF99TM northing/easting (metres) to WGS84 lat/lon (degrees) first.
 *
 * This is the closed-form Gauss–Krüger inverse using the Krüger n-series
 * (Lantmäteriet's documented method — "Gauss Conformal Projection (Transverse
 * Mercator)"), accurate to well under a metre across Sweden. No external
 * dependency (avoids pulling in proj4 for one projection).
 *
 * Reference: Lantmäteriet, "Gauss Conformal Projection ... Formulas for the
 * transformation", and the standard SWEREF99TM parameters below.
 */

// SWEREF99TM projection parameters (GRS80 ellipsoid).
const AXIS = 6_378_137.0; // GRS80 semi-major axis (a), metres
const FLATTENING = 1 / 298.257_222_101; // GRS80 flattening (f)
const CENTRAL_MERIDIAN = 15.0; // λ0, degrees
const SCALE = 0.9996; // k0
const FALSE_NORTHING = 0.0;
const FALSE_EASTING = 500_000.0;

const DEG = 180 / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Convert a SWEREF99TM (EPSG:3006) coordinate to WGS84 lat/lon in degrees.
 *
 * @param northing  SWEREF99TM northing (X), metres.
 * @param easting   SWEREF99TM easting (Y), metres.
 * @returns { lat, lon } in decimal degrees, or null when the inputs are not
 *          finite numbers.
 */
export function sweref99ToWgs84(
  northing: number,
  easting: number,
): LatLon | null {
  if (!Number.isFinite(northing) || !Number.isFinite(easting)) return null;

  // Derived ellipsoid constants.
  const e2 = FLATTENING * (2 - FLATTENING); // first eccentricity squared
  const n = FLATTENING / (2 - FLATTENING); // third flattening
  // Meridian radius mean value (â).
  const aHat = (AXIS / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);

  // Krüger inverse series coefficients (δ1..δ4).
  const delta1 =
    n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3 - (1 / 360) * n ** 4;
  const delta2 = (1 / 48) * n ** 2 + (1 / 15) * n ** 3 - (437 / 1440) * n ** 4;
  const delta3 = (17 / 480) * n ** 3 - (37 / 840) * n ** 4;
  const delta4 = (4397 / 161_280) * n ** 4;

  // Astronomically-correcting series for the latitude (Astp).
  const Astar = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const Bstar = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const Cstar = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const Dstar = -(4279 * e2 ** 4) / 1260;

  const xi = (northing - FALSE_NORTHING) / (SCALE * aHat);
  const eta = (easting - FALSE_EASTING) / (SCALE * aHat);

  const xiPrim =
    xi -
    delta1 * Math.sin(2 * xi) * Math.cosh(2 * eta) -
    delta2 * Math.sin(4 * xi) * Math.cosh(4 * eta) -
    delta3 * Math.sin(6 * xi) * Math.cosh(6 * eta) -
    delta4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaPrim =
    eta -
    delta1 * Math.cos(2 * xi) * Math.sinh(2 * eta) -
    delta2 * Math.cos(4 * xi) * Math.sinh(4 * eta) -
    delta3 * Math.cos(6 * xi) * Math.sinh(6 * eta) -
    delta4 * Math.cos(8 * xi) * Math.sinh(8 * eta);

  const phiStar = Math.asin(Math.sin(xiPrim) / Math.cosh(etaPrim));
  const deltaLambda = Math.atan(Math.sinh(etaPrim) / Math.cos(xiPrim));

  const lon = CENTRAL_MERIDIAN + deltaLambda * DEG;
  const lat =
    (phiStar +
      Math.sin(phiStar) *
        Math.cos(phiStar) *
        (Astar +
          Bstar * Math.sin(phiStar) ** 2 +
          Cstar * Math.sin(phiStar) ** 4 +
          Dstar * Math.sin(phiStar) ** 6)) *
    DEG;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}
