/**
 * Display geometry and selection correspondence for a *stored* recorded track.
 *
 * The server builds the display geometry ({@link MapPath}) and stores it as its own
 * object. This module turns that document into the kit's SDK-free shape and — the part
 * that matters — keeps the mapping from a drawn vertex back to the **source sample id**
 * it came from. A display index is never used as a source index: every selection in this
 * screen travels as a sample id, and the index is only ever a position inside one
 * particular drawn path.
 *
 * Nothing here recomputes a time, a distance, a pace or any training aggregate. The
 * summary comes from the samples ({@link summarizeTrack}), so which vertices happen to be
 * drawn cannot move a single number in it.
 */
import type { MapPath, RecordedTrack, TrackSample } from '@workout/contracts/tracks';
import type { GeoPosition, MapPath as DisplayPath } from '@workout/geo-kit/map-path';
import { mapPathRevision } from './track-preview-geometry';

export interface StoredTrackGeometry {
  /** Kit input: one path, gaps as breaks, one opaque vertex key (= sample id) per vertex. */
  readonly path: DisplayPath;
  /** Sample ids in drawn order, index-aligned with `path.positions`. */
  readonly vertexSampleIds: readonly string[];
  /** Reverse lookup, so a sample id resolves to its drawn vertex without a linear scan. */
  readonly vertexIndexBySampleId: ReadonlyMap<string, number>;
  /** Segments that could not form a line, with the reason the server recorded. */
  readonly insufficient: MapPath['insufficient'];
}

interface DrawnPiece {
  readonly segmentIndex: number;
  readonly positions: readonly GeoPosition[];
  readonly sampleIds: readonly string[];
}

/**
 * Flatten the stored multi-line geometry into one kit path.
 *
 * Lines and single-sample points are merged back into recording order by their source
 * segment index, and every boundary between pieces becomes a break, so the drawn line
 * stops and restarts instead of bridging a gap with a straight edge. A single-sample
 * piece stays a piece of its own, which the kit renders as a point rather than a line.
 */
export function buildStoredTrackGeometry(mapPath: MapPath, pathId: string): StoredTrackGeometry {
  const pieces: DrawnPiece[] = [];
  mapPath.geometry.coordinates.forEach((line, index) => {
    const segmentIndex = mapPath.lineSegmentIndices[index];
    const sampleIds = mapPath.vertexSampleIds[index];
    // The contract already refines both arrays to the same length as `coordinates`; a
    // document that somehow lacks one is dropped rather than drawn with invented keys.
    if (segmentIndex === undefined || sampleIds === undefined) return;
    if (sampleIds.length !== line.length) return;
    pieces.push({ segmentIndex, positions: line, sampleIds });
  });
  for (const point of mapPath.points)
    pieces.push({
      segmentIndex: point.segmentIndex,
      positions: [point.position],
      sampleIds: [point.sampleId],
    });
  pieces.sort((left, right) => left.segmentIndex - right.segmentIndex);

  const positions: GeoPosition[] = [];
  const vertexSampleIds: string[] = [];
  const breaks: number[] = [];
  const vertexIndexBySampleId = new Map<string, number>();
  for (const piece of pieces) {
    if (positions.length > 0) breaks.push(positions.length);
    piece.positions.forEach((position, offset) => {
      const sampleId = piece.sampleIds[offset];
      if (sampleId === undefined) return;
      vertexIndexBySampleId.set(sampleId, positions.length);
      positions.push(position);
      vertexSampleIds.push(sampleId);
    });
  }
  return {
    path: {
      id: pathId,
      role: mapPath.role,
      revision: mapPathRevision(mapPath.sourceRevision),
      positions,
      breaks,
      vertexKeys: vertexSampleIds,
    },
    vertexSampleIds,
    vertexIndexBySampleId,
    insufficient: mapPath.insufficient,
  };
}

/**
 * The source side of the correspondence, indexed once.
 *
 * Instants are keyed by parsed epoch milliseconds rather than by their wire text, because
 * `2026-03-01T00:00:00Z` and `2026-03-01T00:00:00.000Z` are the same instant and a text
 * key would silently fail to match them.
 */
export interface StoredTrackIndex {
  readonly bySampleId: ReadonlyMap<string, TrackSample>;
  /** Epoch ms → sample ids at that instant, in source order. */
  readonly sampleIdsByInstant: ReadonlyMap<number, readonly string[]>;
  /** Lap ordinal reported by the source stream → its sample ids, in source order. */
  readonly sampleIdsByLapIndex: ReadonlyMap<number, readonly string[]>;
  /** Samples that carry an instant, in source order, for range queries. */
  readonly timedSamples: readonly { readonly sampleId: string; readonly instant: number }[];
}

function instantOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function indexStoredTrack(track: RecordedTrack): StoredTrackIndex {
  const bySampleId = new Map<string, TrackSample>();
  const sampleIdsByInstant = new Map<number, string[]>();
  const sampleIdsByLapIndex = new Map<number, string[]>();
  const timedSamples: { sampleId: string; instant: number }[] = [];
  for (const sample of track.samples) {
    bySampleId.set(sample.sampleId, sample);
    const instant = instantOf(sample.recordedAt);
    if (instant !== null) {
      const existing = sampleIdsByInstant.get(instant);
      if (existing) existing.push(sample.sampleId);
      else sampleIdsByInstant.set(instant, [sample.sampleId]);
      timedSamples.push({ sampleId: sample.sampleId, instant });
    }
    if (sample.lapIndex !== null) {
      const existing = sampleIdsByLapIndex.get(sample.lapIndex);
      if (existing) existing.push(sample.sampleId);
      else sampleIdsByLapIndex.set(sample.lapIndex, [sample.sampleId]);
    }
  }
  return { bySampleId, sampleIdsByInstant, sampleIdsByLapIndex, timedSamples };
}

/**
 * The result of looking a correspondence up by instant.
 *
 * `ambiguous` is not a failure to be smoothed over: two samples recorded at the same
 * instant are two different places, and picking the first one deterministically would
 * silently move a selection to a point the user did not choose. The screen says the
 * correspondence is ambiguous instead.
 */
export type InstantCorrespondence =
  | { readonly kind: 'unique'; readonly sampleId: string }
  | {
      readonly kind: 'ambiguous';
      /** Which side of the correspondence has more than one entry at that instant. */
      readonly reason: 'samples' | 'observations';
      readonly count: number;
    }
  | { readonly kind: 'none' };

/**
 * The sample a detail observation corresponds to.
 *
 * The stored track contract has a `detailLink` field for this, but the current FIT and
 * GPX parsers leave it `null` for every sample, so there is no stored link to follow. The
 * correspondence used here is therefore the recorded instant, which both sides carry from
 * the same source stream — and it is reported as such on screen rather than presented as
 * a stored link. An instant carried by several samples has no single answer and is
 * reported as `ambiguous`; an instant no sample carries is `none`. Neither case picks a
 * nearby or a first sample.
 */
export function sampleForInstant(
  index: StoredTrackIndex,
  instant: number | null,
): InstantCorrespondence {
  if (instant === null) return { kind: 'none' };
  const found = index.sampleIdsByInstant.get(instant);
  if (found === undefined || found.length === 0) return { kind: 'none' };
  if (found.length > 1) return { kind: 'ambiguous', reason: 'samples', count: found.length };
  const [only] = found;
  return only === undefined ? { kind: 'none' } : { kind: 'unique', sampleId: only };
}

export type LapCorrespondenceBasis = 'lap-index' | 'time-range' | 'none';

export interface LapCorrespondence {
  readonly sampleIds: readonly string[];
  readonly basis: LapCorrespondenceBasis;
}

/**
 * Samples belonging to one lap.
 *
 * A FIT recording carries the lap ordinal on each sample, which is a stored
 * correspondence and is preferred. A GPX recording carries none, so the lap's own
 * start/elapsed range is used instead — a weaker correspondence, and the basis is
 * returned so the screen can say which one it used rather than implying the stored one.
 */
export function lapCorrespondence(
  index: StoredTrackIndex,
  lapIndex: number,
  range: { readonly start: number; readonly end: number } | null,
): LapCorrespondence {
  const stored = index.sampleIdsByLapIndex.get(lapIndex);
  if (stored && stored.length > 0) return { sampleIds: stored, basis: 'lap-index' };
  if (range === null) return { sampleIds: [], basis: 'none' };
  const within = samplesInRange(index, range);
  return within.length > 0
    ? { sampleIds: within, basis: 'time-range' }
    : { sampleIds: [], basis: 'none' };
}

/** Sample ids whose instant lies inside the range, endpoints included, in source order. */
export function samplesInRange(
  index: StoredTrackIndex,
  range: { readonly start: number; readonly end: number },
): readonly string[] {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start > range.end)
    return [];
  return index.timedSamples
    .filter((entry) => entry.instant >= range.start && entry.instant <= range.end)
    .map((entry) => entry.sampleId);
}

/**
 * Detail observation indices per instant, so a vertex picked on the map can select the
 * same observation in the chart and the record table. Several observations may share an
 * instant, and that is kept rather than reduced to the lowest one: the caller must be able
 * to tell "one observation" from "several".
 */
export type RecordInstantIndex = ReadonlyMap<number, readonly number[]>;

export function buildRecordInstantIndex(
  records: readonly { readonly index: number; readonly timestamp: string | null }[],
): RecordInstantIndex {
  const byInstant = new Map<number, number[]>();
  for (const record of records) {
    const instant = instantOf(record.timestamp);
    if (instant === null) continue;
    const existing = byInstant.get(instant);
    if (existing) existing.push(record.index);
    else byInstant.set(instant, [record.index]);
  }
  for (const indices of byInstant.values()) indices.sort((left, right) => left - right);
  return byInstant;
}

/**
 * The sample a selected observation definitely belongs to.
 *
 * The mirror of {@link definiteRecordForSample}, and it applies exactly the same rule:
 * both sides must be unambiguous at that instant. One sample and two observations is not
 * a definite link either — the sample cannot be said to be *this* observation's position
 * rather than its twin's. Without this the two directions disagreed: the chart would
 * commit a marker that the reverse click then refused to link back, so selecting the
 * observation and then its own sample dropped the observation selection.
 */
export function definiteSampleForRecord(
  index: StoredTrackIndex,
  records: RecordInstantIndex,
  instant: number | null,
): InstantCorrespondence {
  const sample = sampleForInstant(index, instant);
  if (sample.kind !== 'unique' || instant === null) return sample;
  const observations = records.get(instant)?.length ?? 0;
  return observations > 1
    ? { kind: 'ambiguous', reason: 'observations', count: observations }
    : sample;
}

/**
 * The observation a picked sample definitely belongs to.
 *
 * Both sides must be unambiguous at that instant. One observation and two samples at the
 * same instant is not a definite link either: the observation cannot be said to belong to
 * *this* sample rather than to its twin, and selecting it would move the chart to a point
 * the user did not choose. `null` therefore means "no definite link", and the caller
 * leaves the observation selection alone instead of guessing.
 */
export function definiteRecordForSample(
  index: StoredTrackIndex,
  records: RecordInstantIndex,
  sampleId: string,
): { readonly recordIndex: number; readonly instant: number } | null {
  const instant = instantOf(index.bySampleId.get(sampleId)?.recordedAt ?? null);
  if (instant === null) return null;
  if ((index.sampleIdsByInstant.get(instant)?.length ?? 0) !== 1) return null;
  const candidates = records.get(instant);
  if (candidates === undefined || candidates.length !== 1) return null;
  const [only] = candidates;
  return only === undefined ? null : { recordIndex: only, instant };
}

/**
 * The drawn runs covered by a set of sample ids, as a path of its own.
 *
 * Used to highlight the time range a lap or an explicit range selection covers. Vertices
 * that are not consecutive in drawn order become separate pieces, so a highlight never
 * joins two sides of a gap. Returns `null` when nothing in the set is drawn.
 */
export function buildHighlightPath(
  geometry: StoredTrackGeometry,
  sampleIds: readonly string[],
  pathId: string,
): DisplayPath | null {
  const vertices = [
    ...new Set(
      sampleIds
        .map((sampleId) => geometry.vertexIndexBySampleId.get(sampleId))
        .filter((vertex): vertex is number => vertex !== undefined),
    ),
  ].sort((left, right) => left - right);
  if (vertices.length === 0) return null;
  // A highlight must break wherever the recording itself breaks, not only where the
  // selected vertices are non-adjacent: two vertices on either side of a gap are next to
  // each other in drawn order but were never travelled between.
  const sourceBreaks = new Set(geometry.path.breaks ?? []);
  const positions: GeoPosition[] = [];
  const keys: string[] = [];
  const breaks: number[] = [];
  let previous: number | null = null;
  for (const vertex of vertices) {
    const position = geometry.path.positions[vertex];
    const key = geometry.vertexSampleIds[vertex];
    if (position === undefined || key === undefined) continue;
    if (previous !== null && (vertex !== previous + 1 || sourceBreaks.has(vertex)))
      breaks.push(positions.length);
    positions.push(position);
    keys.push(key);
    previous = vertex;
  }
  if (positions.length === 0) return null;
  return {
    id: pathId,
    role: 'candidate',
    revision: `${geometry.path.revision}:${keys[0]}:${keys[keys.length - 1]}:${keys.length}`,
    positions,
    breaks,
    vertexKeys: keys,
  };
}
