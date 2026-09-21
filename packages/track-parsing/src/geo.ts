import type { TrackPosition } from '@workout/contracts/tracks';

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance. Recomputed GPS distance, never the device-reported value. */
export function haversineMeters(from: TrackPosition, to: TrackPosition): number {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A jump of more than half the globe in longitude is an antimeridian crossing. */
export function crossesAntimeridian(from: TrackPosition, to: TrackPosition): boolean {
  return Math.abs(to[0] - from[0]) > 180;
}

/** Web-mercator display limit; positions beyond it cannot be shown on a square tile grid. */
export const MAX_DISPLAY_LATITUDE = 85.05112878;

export function outsideDisplayLatitude(position: TrackPosition): boolean {
  return Math.abs(position[1]) > MAX_DISPLAY_LATITUDE;
}

/** Local equirectangular metres, used only for display simplification distances. */
export function localMeters(position: TrackPosition, referenceLatitude: number): [number, number] {
  return [
    toRadians(position[0]) * Math.cos(toRadians(referenceLatitude)) * EARTH_RADIUS_METERS,
    toRadians(position[1]) * EARTH_RADIUS_METERS,
  ];
}
