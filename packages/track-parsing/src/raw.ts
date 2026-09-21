import type { TrackPosition } from '@workout/contracts/tracks';

/** Parser output before segmentation. One entry per source observation, none invented. */
export interface RawSample {
  readonly sourceIndex: number;
  readonly recordedAt: string | null;
  readonly position: TrackPosition | null;
  readonly elevationMeters: number | null;
  readonly distanceMeters: number | null;
  readonly speedMetersPerSecond: number | null;
  readonly heartRateBpm: number | null;
  readonly lapIndex: number | null;
  /** A source-declared boundary that must start a new segment regardless of continuity. */
  readonly boundary: 'gpx-trkseg' | 'fit-session' | 'fit-event-stop' | null;
}

export interface RawTrack {
  readonly streamIndex: number;
  /** Ordinal within the stream: FIT session order, always 0 for a GPX `trk`. */
  readonly sourceItemIndex: number;
  readonly sourceKind: 'fit-session' | 'gpx-trk';
  readonly name: string | null;
  readonly samples: readonly RawSample[];
  /** Device-reported total, from the FIT session message. GPX `trk` has none. */
  readonly deviceDistanceMeters: number | null;
}

export interface RawRoutePoint {
  readonly sourceIndex: number;
  readonly position: TrackPosition;
  readonly elevationMeters: number | null;
  readonly name: string | null;
}

export interface RawRoute {
  readonly streamIndex: number;
  readonly name: string | null;
  readonly points: readonly RawRoutePoint[];
}

export interface RawTrackFile {
  readonly tracks: readonly RawTrack[];
  readonly routes: readonly RawRoute[];
  readonly waypoints: readonly RawRoutePoint[];
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}
