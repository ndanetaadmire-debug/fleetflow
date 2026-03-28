export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Travel-time estimate. Straight-line distance × a road-network detour factor,
 * at an average urban speed. Swap for a routing API (OSRM, Google) behind the
 * same signature when accuracy matters more than cost.
 */
export function etaSeconds(a: LatLng, b: LatLng, opts: { speedKmh?: number; detour?: number } = {}): number {
  const speed = ((opts.speedKmh ?? 35) * 1000) / 3600;
  return Math.round((haversine(a, b) * (opts.detour ?? 1.35)) / speed);
}

export function isValidLatLng(p: LatLng): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}
