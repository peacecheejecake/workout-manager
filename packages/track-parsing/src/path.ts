import {
  mapPathSchema,
  type MapPath,
  type RecordedTrack,
  type TrackPosition,
} from '@workout/contracts/tracks';
import { haversineMeters, outsideDisplayLatitude } from './geo';
import { TrackIngestionError } from './limits';
import { simplifyIndices } from './simplify';

export interface MapPathOptions {
  readonly role?: 'recorded' | 'planned' | 'candidate';
  /** Display tolerance. 0 keeps every vertex. */
  readonly toleranceMeters?: number;
}

/**
 * Display geometry for one recorded track. A segment with fewer than two positions is
 * reported as a point or as an insufficient state; a line is never fabricated, and gaps
 * are never closed by joining the samples on either side.
 */
export function buildMapPath(track: RecordedTrack, options: MapPathOptions = {}): MapPath {
  const tolerance = options.toleranceMeters ?? 0;
  const byId = new Map(track.samples.map((sample) => [sample.sampleId, sample]));
  const coordinates: TrackPosition[][] = [];
  const vertexSampleIds: string[][] = [];
  const lineSegmentIndices: number[] = [];
  const points: MapPath['points'] = [];
  const insufficient: MapPath['insufficient'] = [];
  let outside = false;
  for (const segment of track.segments) {
    const positioned = segment.sampleIds
      .map((sampleId) => byId.get(sampleId))
      .filter((sample): sample is NonNullable<typeof sample> => sample?.position != null);
    for (const sample of positioned)
      if (sample.position && outsideDisplayLatitude(sample.position)) outside = true;
    if (positioned.length === 0) {
      insufficient.push({
        segmentIndex: segment.index,
        reason: 'no-position',
        sampleIds: [...segment.sampleIds],
      });
      continue;
    }
    const head = positioned[0];
    if (positioned.length === 1 && head?.position) {
      points.push({
        segmentIndex: segment.index,
        sampleId: head.sampleId,
        position: head.position,
      });
      insufficient.push({
        segmentIndex: segment.index,
        reason: 'single-point',
        sampleIds: [head.sampleId],
      });
      continue;
    }
    const line = positioned.map((sample) => sample.position).filter((p): p is TrackPosition => !!p);
    const kept = simplifyIndices(line, tolerance);
    coordinates.push(kept.flatMap((index) => (line[index] ? [line[index]] : [])));
    vertexSampleIds.push(
      kept.flatMap((index) => {
        const sample = positioned[index];
        return sample ? [sample.sampleId] : [];
      }),
    );
    lineSegmentIndices.push(segment.index);
  }
  let length: number | null = coordinates.length === 0 ? null : 0;
  for (const line of coordinates)
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1];
      const to = line[index];
      if (from && to) length = (length ?? 0) + haversineMeters(from, to);
    }
  const path = {
    schemaVersion: 1,
    role: options.role ?? 'recorded',
    sourceRevision: track.provenance,
    simplificationVersion: 1,
    toleranceMeters: tolerance,
    geometry: { type: 'MultiLineString', coordinates },
    vertexSampleIds,
    lineSegmentIndices,
    points,
    insufficient,
    displayedPolylineLengthMeters: length,
    crossesAntimeridian: track.segments.some(
      (segment) => segment.startReason === 'antimeridian-crossing',
    ),
    outsideDisplayLatitude: outside,
  };
  const parsed = mapPathSchema.safeParse(path);
  if (!parsed.success) throw new TrackIngestionError('TRACK_NORMALIZATION_INVALID');
  return parsed.data;
}
