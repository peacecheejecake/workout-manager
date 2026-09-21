import type { TrackPosition } from '@workout/contracts/tracks';
import {
  ESTIMATED_SAMPLE_BYTES,
  TrackIngestionError,
  type ParseBudget,
  type TrackParseLimits,
} from './limits';
import {
  type RawRoute,
  type RawRoutePoint,
  type RawSample,
  type RawTrack,
  type RawTrackFile,
  isInstant,
} from './raw';
import { sanitizeMetadataText } from './sanitize';
import { localName, scanXml } from './xml';

const GPX_NAMESPACES = new Set([
  'http://www.topografix.com/GPX/1/1',
  'http://www.topografix.com/GPX/1/0',
]);
/** Heart rate is only read from Garmin's TrackPointExtension, in its own namespace. */
const TRACK_POINT_EXTENSION_NAMESPACES = new Set([
  'http://www.garmin.com/xmlschemas/TrackPointExtension/v1',
  'http://www.garmin.com/xmlschemas/TrackPointExtension/v2',
]);

/** Text that is absent or blank is unknown. It never becomes 0. */
function optionalNumber(value: string, min: number, max: number): number | null {
  const text = value.trim();
  if (text.length === 0) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/** A missing or blank coordinate is rejected: `lat=""` is not latitude 0. */
function requiredCoordinate(raw: string | undefined, limit: number): number {
  if (raw === undefined) throw new TrackIngestionError('TRACK_COORDINATE_INVALID');
  const text = raw.trim();
  const parsed = Number(text);
  if (text.length === 0 || !Number.isFinite(parsed) || Math.abs(parsed) > limit)
    throw new TrackIngestionError('TRACK_COORDINATE_INVALID');
  return parsed;
}

function coordinate(attributes: ReadonlyMap<string, string>): TrackPosition {
  const latitude = requiredCoordinate(attributes.get('lat'), 90);
  const longitude = requiredCoordinate(attributes.get('lon'), 180);
  return [longitude, latitude];
}

interface PointDraft {
  position: TrackPosition;
  recordedAt: string | null;
  elevationMeters: number | null;
  heartRateBpm: number | null;
  name: string | null;
}

interface ElementScope {
  readonly local: string;
  readonly namespace: string;
  readonly declarations: ReadonlyMap<string, string>;
}

function declarationsOf(attributes: ReadonlyMap<string, string>): Map<string, string> {
  const declared = new Map<string, string>();
  for (const [key, value] of attributes) {
    if (key === 'xmlns') declared.set('', value);
    else if (key.startsWith('xmlns:')) declared.set(key.slice(6), value);
  }
  return declared;
}

/** Namespace resolution is scoped: an unrelated declaration elsewhere proves nothing. */
function resolveNamespace(
  name: string,
  declared: ReadonlyMap<string, string>,
  stack: readonly ElementScope[],
): string {
  const colon = name.indexOf(':');
  const prefix = colon < 0 ? '' : name.slice(0, colon);
  if (declared.has(prefix)) return declared.get(prefix) ?? '';
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const scope = stack[index];
    if (scope?.declarations.has(prefix)) return scope.declarations.get(prefix) ?? '';
  }
  return '';
}

/**
 * `hr` is read only from `trkpt > extensions > TrackPointExtension > hr`, every link
 * checked: the extension element and `hr` in a Garmin namespace, `extensions` in the GPX
 * namespace, and `extensions` a DIRECT child of the track point being read.
 */
function isTrackPointExtension(stack: readonly ElementScope[]): boolean {
  const parent = stack.at(-1);
  const grandparent = stack.at(-2);
  const greatGrandparent = stack.at(-3);
  return (
    parent !== undefined &&
    parent.local === 'TrackPointExtension' &&
    TRACK_POINT_EXTENSION_NAMESPACES.has(parent.namespace) &&
    grandparent !== undefined &&
    grandparent.local === 'extensions' &&
    GPX_NAMESPACES.has(grandparent.namespace) &&
    greatGrandparent !== undefined &&
    greatGrandparent.local === 'trkpt' &&
    GPX_NAMESPACES.has(greatGrandparent.namespace)
  );
}

/**
 * Bounded GPX reader. `trk`, `rte` and `wpt` stay distinct: a route is never returned as a
 * recorded track. Every `trkseg` starts a new segment boundary. Only elements in the GPX
 * namespace, under the single GPX root and in their required parent, are interpreted.
 */
export function parseGpx(
  source: string,
  limits: TrackParseLimits,
  budget: ParseBudget,
): RawTrackFile {
  const tracks: RawTrack[] = [];
  const routes: RawRoute[] = [];
  const waypoints: RawRoutePoint[] = [];
  const stack: ElementScope[] = [];
  let rootSeen = false;
  let track: { name: string | null; samples: RawSample[] } | null = null;
  let route: { name: string | null; points: RawRoutePoint[] } | null = null;
  let point: PointDraft | null = null;
  let pointKind: 'trkpt' | 'rtept' | 'wpt' | null = null;
  let segmentBoundaryPending = false;
  let text = '';
  let textOwner = '';
  let sampleCount = 0;

  const parentIs = (expected: string): boolean => {
    const parent = stack.at(-1);
    return (
      parent !== undefined && parent.local === expected && GPX_NAMESPACES.has(parent.namespace)
    );
  };

  for (const event of scanXml(source, limits, budget)) {
    if (event.kind === 'text') {
      text += event.value;
      continue;
    }
    const name = localName(event.name);
    if (event.kind === 'open') {
      const declared = declarationsOf(event.attributes);
      const namespace = resolveNamespace(event.name, declared, stack);
      const isRoot = stack.length === 0;
      if (isRoot) {
        // A well-formed document has exactly one root; a second one is not "more data".
        if (rootSeen) throw new TrackIngestionError('TRACK_GPX_INVALID_ROOT');
        if (name !== 'gpx' || !GPX_NAMESPACES.has(namespace))
          throw new TrackIngestionError('TRACK_GPX_INVALID_ROOT');
        rootSeen = true;
      } else if (name === 'gpx' && GPX_NAMESPACES.has(namespace))
        // A nested `gpx` would make an inner element look like a child of the root and
        // could silently replace the track being built. There is no valid nested root.
        throw new TrackIngestionError('TRACK_GPX_INVALID_ROOT');
      const gpxElement = GPX_NAMESPACES.has(namespace);
      if (gpxElement && !isRoot)
        switch (name) {
          case 'trk':
          case 'rte':
          case 'wpt':
            if (!parentIs('gpx')) throw new TrackIngestionError('TRACK_XML_MALFORMED');
            break;
          case 'trkseg':
            if (!parentIs('trk')) throw new TrackIngestionError('TRACK_XML_MALFORMED');
            break;
          case 'trkpt':
            if (!parentIs('trkseg')) throw new TrackIngestionError('TRACK_XML_MALFORMED');
            break;
          case 'rtept':
            if (!parentIs('rte')) throw new TrackIngestionError('TRACK_XML_MALFORMED');
            break;
          default:
            break;
        }
      stack.push({ local: name, namespace, declarations: declared });
      text = '';
      textOwner = name;
      if (!gpxElement || isRoot) continue;
      switch (name) {
        case 'trk':
          // Never discard a track in progress by starting another one.
          if (track !== null || route !== null)
            throw new TrackIngestionError('TRACK_XML_MALFORMED');
          if (tracks.length + routes.length >= limits.tracksPerFile)
            throw new TrackIngestionError('TRACK_COUNT_LIMIT');
          track = { name: null, samples: [] };
          break;
        case 'trkseg':
          segmentBoundaryPending = true;
          break;
        case 'rte':
          if (track !== null || route !== null)
            throw new TrackIngestionError('TRACK_XML_MALFORMED');
          if (tracks.length + routes.length >= limits.tracksPerFile)
            throw new TrackIngestionError('TRACK_COUNT_LIMIT');
          route = { name: null, points: [] };
          break;
        case 'trkpt':
        case 'rtept':
        case 'wpt':
          if (point !== null) throw new TrackIngestionError('TRACK_XML_MALFORMED');
          budget.charge(ESTIMATED_SAMPLE_BYTES);
          pointKind = name;
          point = {
            position: coordinate(event.attributes),
            recordedAt: null,
            elevationMeters: null,
            heartRateBpm: null,
            name: null,
          };
          break;
        default:
          break;
      }
      continue;
    }
    const closing = stack.pop();
    const value = text.trim();
    text = '';
    const owned = textOwner === name;
    textOwner = '';
    const gpxElement = closing !== undefined && GPX_NAMESPACES.has(closing.namespace);
    // Heart rate is read only from `trkpt > extensions > TrackPointExtension > hr` in a
    // Garmin TrackPointExtension namespace. Any other `hr` is somebody else's element.
    if (
      name === 'hr' &&
      owned &&
      point &&
      pointKind === 'trkpt' &&
      closing !== undefined &&
      TRACK_POINT_EXTENSION_NAMESPACES.has(closing.namespace) &&
      isTrackPointExtension(stack)
    ) {
      const beats = optionalNumber(value, 0, 255);
      point.heartRateBpm = beats === null ? null : Math.round(beats);
      continue;
    }
    if (!gpxElement) continue;
    switch (name) {
      case 'name':
        if (owned) {
          const cleaned = sanitizeMetadataText(value, limits.metadataTextLength);
          if (point) point.name = cleaned;
          else if (route) route.name = cleaned;
          else if (track) track.name = cleaned;
        }
        break;
      case 'ele':
        if (owned && point) point.elevationMeters = optionalNumber(value, -12_000, 12_000);
        break;
      case 'time':
        if (owned && point) {
          if (value.length > 0 && !isInstant(value))
            throw new TrackIngestionError('TRACK_XML_MALFORMED');
          point.recordedAt = value.length > 0 ? value : null;
        }
        break;
      case 'trkpt': {
        if (!point || !track || pointKind !== 'trkpt') break;
        sampleCount += 1;
        if (sampleCount > limits.samples) throw new TrackIngestionError('TRACK_SAMPLE_LIMIT');
        track.samples.push({
          sourceIndex: track.samples.length,
          recordedAt: point.recordedAt,
          position: point.position,
          elevationMeters: point.elevationMeters,
          distanceMeters: null,
          speedMetersPerSecond: null,
          heartRateBpm: point.heartRateBpm,
          lapIndex: null,
          boundary: segmentBoundaryPending ? 'gpx-trkseg' : null,
        });
        segmentBoundaryPending = false;
        point = null;
        pointKind = null;
        break;
      }
      case 'rtept': {
        if (!point || !route || pointKind !== 'rtept') break;
        if (route.points.length >= limits.samples)
          throw new TrackIngestionError('TRACK_SAMPLE_LIMIT');
        route.points.push({
          sourceIndex: route.points.length,
          position: point.position,
          elevationMeters: point.elevationMeters,
          name: point.name,
        });
        point = null;
        pointKind = null;
        break;
      }
      case 'wpt': {
        if (!point || pointKind !== 'wpt') break;
        if (waypoints.length >= limits.samples) throw new TrackIngestionError('TRACK_SAMPLE_LIMIT');
        waypoints.push({
          sourceIndex: waypoints.length,
          position: point.position,
          elevationMeters: point.elevationMeters,
          name: point.name,
        });
        point = null;
        pointKind = null;
        break;
      }
      case 'trk':
        if (track && track.samples.length > 0)
          tracks.push({
            streamIndex: tracks.length,
            sourceItemIndex: 0,
            sourceKind: 'gpx-trk',
            name: track.name,
            samples: track.samples,
            deviceDistanceMeters: null,
          });
        track = null;
        break;
      case 'rte':
        if (route && route.points.length > 0)
          routes.push({ streamIndex: routes.length, name: route.name, points: route.points });
        route = null;
        break;
      default:
        break;
    }
    budget.check();
  }
  if (!rootSeen) throw new TrackIngestionError('TRACK_GPX_INVALID_ROOT');
  return { tracks, routes, waypoints };
}
