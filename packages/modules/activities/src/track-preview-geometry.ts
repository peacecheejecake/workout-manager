/**
 * Pure derivations for the local-file track preview.
 *
 * Everything here reads a contract-validated {@link RecordedTrack} and produces display
 * values. It never parses bytes, never calls the network and never fabricates a value:
 * a missing measurement stays `null` rather than becoming `0`.
 *
 * The geo-kit `MapPath` is a *display* shape whose vertex keys are opaque to the kit.
 * This module is the explicit correspondence M2-01d left open: a vertex key here is the
 * track sample id it came from, so a picked vertex maps back to a source sample and
 * never to a display index.
 */
import type { RecordedTrack, TrackProvenance, TrackSample } from '@workout/contracts/tracks';
import type { GeoPosition, MapPath } from '@workout/geo-kit/map-path';

/** Control, bidi-override and angle-bracket characters never reach the screen. */
export function sanitizeDisplayText(value: string, maxLength = 256): string {
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const bidi = code >= 0x202a && code <= 0x202e;
    const isolate = code >= 0x2066 && code <= 0x2069;
    if (control || bidi || isolate) continue;
    if (character === '<' || character === '>') continue;
    cleaned += character;
    if (cleaned.length >= maxLength) break;
  }
  return cleaned;
}

export interface TrackPreviewSummary {
  readonly sampleCount: number;
  readonly positionedSampleCount: number;
  readonly segmentCount: number;
  readonly elapsedSeconds: number | null;
  /** Device-reported cumulative distance. Never replaced by a GPS recomputation. */
  readonly deviceDistanceMeters: number | null;
  /** Recomputed from positions by the parser. A different number, kept separate. */
  readonly recomputedDistanceMeters: number | null;
  /** Derived from the device distance only; unknown when the device reported none. */
  readonly averagePaceSecondsPerKilometer: number | null;
  /** Unweighted mean over samples that reported a heart rate, not a device average. */
  readonly averageHeartRateBpm: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/**
 * Summary over samples only. Selection, zoom and any display simplification cannot
 * change these numbers because none of them reads display geometry.
 */
export function summarizeTrack(track: RecordedTrack): TrackPreviewSummary {
  const times: number[] = [];
  const instants: string[] = [];
  let heartSum = 0;
  let heartCount = 0;
  let positioned = 0;
  for (const sample of track.samples) {
    if (sample.position !== null) positioned += 1;
    if (sample.recordedAt !== null) {
      times.push(Date.parse(sample.recordedAt));
      instants.push(sample.recordedAt);
    }
    if (sample.heartRateBpm !== null) {
      heartSum += sample.heartRateBpm;
      heartCount += 1;
    }
  }
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  const elapsedSeconds = first === null || last === null ? null : (last - first) / 1000;
  const device = track.distances.deviceReportedMeters;
  const ordered = [...instants].sort();
  return {
    sampleCount: track.samples.length,
    positionedSampleCount: positioned,
    segmentCount: track.segments.length,
    elapsedSeconds,
    deviceDistanceMeters: device,
    recomputedDistanceMeters: track.distances.recomputedFromPositionsMeters,
    averagePaceSecondsPerKilometer:
      elapsedSeconds === null || elapsedSeconds <= 0 || device === null || device <= 0
        ? null
        : (elapsedSeconds / device) * 1000,
    averageHeartRateBpm: heartCount === 0 ? null : heartSum / heartCount,
    startedAt: ordered[0] ?? null,
    endedAt: ordered[ordered.length - 1] ?? null,
  };
}

export interface TrackBreakCount {
  readonly reason: RecordedTrack['segments'][number]['startReason'];
  readonly count: number;
}

/**
 * Why the recording is drawn as several disconnected pieces. The first segment's
 * `stream-start` is not a break, so an intact recording reports an empty list.
 */
export function countBreaks(track: RecordedTrack): TrackBreakCount[] {
  const counts = new Map<TrackBreakCount['reason'], number>();
  for (const segment of track.segments.slice(1))
    counts.set(segment.startReason, (counts.get(segment.startReason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

/** Opaque geometry revision for the kit: different bytes or track mean different geometry. */
export function mapPathRevision(provenance: TrackProvenance): string {
  return provenance.kind === 'local-file'
    ? `${provenance.fileSha256}:${provenance.streamIndex}:${provenance.sourceItemIndex}`
    : `${provenance.activityId}:${provenance.trackRevision}`;
}

export interface TrackPreviewGeometry {
  readonly path: MapPath;
  /** Sample ids in drawn order; index-aligned with `path.positions`. */
  readonly vertexSampleIds: readonly string[];
  /** Samples that carry no position. They keep their measurements and are never drawn. */
  readonly unpositionedSampleIds: readonly string[];
}

/**
 * Display geometry for one recorded track.
 *
 * A segment boundary becomes a break, so the drawn line stops and restarts instead of
 * bridging the gap with a straight edge. A segment whose samples have no position
 * contributes no vertex and no break; a segment with exactly one position becomes an
 * isolated vertex which the kit renders as a point, never as a line.
 */
export function buildPreviewGeometry(track: RecordedTrack, pathId: string): TrackPreviewGeometry {
  const byId = new Map<string, TrackSample>(
    track.samples.map((sample) => [sample.sampleId, sample]),
  );
  const positions: GeoPosition[] = [];
  const vertexSampleIds: string[] = [];
  const unpositionedSampleIds: string[] = [];
  const breaks: number[] = [];
  for (const segment of track.segments) {
    let added = 0;
    for (const sampleId of segment.sampleIds) {
      const sample = byId.get(sampleId);
      if (!sample) continue;
      if (sample.position === null) {
        unpositionedSampleIds.push(sampleId);
        continue;
      }
      if (added === 0 && positions.length > 0) breaks.push(positions.length);
      positions.push(sample.position);
      vertexSampleIds.push(sampleId);
      added += 1;
    }
  }
  return {
    path: {
      id: pathId,
      role: 'recorded',
      revision: mapPathRevision(track.provenance),
      positions,
      breaks,
      vertexKeys: vertexSampleIds,
    },
    vertexSampleIds,
    unpositionedSampleIds,
  };
}
