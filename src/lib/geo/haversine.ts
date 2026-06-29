/**
 * Haversine distance between two WGS84 lat/lon points.
 *
 * Returns the great-circle distance in kilometres, using Earth radius 6371 km.
 * This is a pure function with no I/O — safe to call anywhere.
 *
 * Accuracy note: the haversine formula assumes a spherical Earth. For the
 * distances involved in nearest-station lookups (tens to hundreds of km),
 * the error vs. the WGS84 ellipsoid is well under 0.5% — negligible for our
 * use case.
 */
export function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371; // Earth radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLon * sinDLon;

  return 2 * R * Math.asin(Math.sqrt(h));
}
