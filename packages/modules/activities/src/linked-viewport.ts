import { computeBounds, type MapBounds } from '@workout/geo-kit/map-path';
import type { TimeRange } from './detail-projection';
import type { StoredTrackGeometry } from './stored-track-geometry';

type ViewportGeometry = Pick<StoredTrackGeometry, 'path' | 'vertexSampleIds'>;
type TimedSampleIndex = {
  readonly bySampleId: ReadonlyMap<string, { readonly recordedAt: string | null }>;
};

function positionInBounds(longitude: number, latitude: number, bounds: MapBounds): boolean {
  const between = (candidate: number) => candidate >= bounds.west && candidate <= bounds.east;
  const longitudeInside = bounds.crossesAntimeridian
    ? longitude >= bounds.west || longitude <= bounds.east
    : between(longitude) || between(longitude - 360) || between(longitude + 360);
  return longitudeInside && latitude >= bounds.south && latitude <= bounds.north;
}

/** Only positioned source samples with known instants can link the two views. */
export function timeDomainInViewport(
  geometry: ViewportGeometry,
  index: TimedSampleIndex,
  bounds: MapBounds,
): TimeRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let count = 0;
  geometry.path.positions.forEach(([longitude, latitude], vertex) => {
    if (!positionInBounds(longitude, latitude, bounds)) return;
    const sampleId = geometry.vertexSampleIds[vertex];
    const instant = sampleId ? Date.parse(index.bySampleId.get(sampleId)?.recordedAt ?? '') : NaN;
    if (!Number.isFinite(instant)) return;
    start = Math.min(start, instant);
    end = Math.max(end, instant);
    count += 1;
  });
  return count === 0 ? null : { start, end };
}

export function viewportForTimeDomain(
  geometry: ViewportGeometry,
  index: TimedSampleIndex,
  domain: TimeRange,
): MapBounds | null {
  const positions = geometry.path.positions.filter((_, vertex) => {
    const sampleId = geometry.vertexSampleIds[vertex];
    const instant = sampleId ? Date.parse(index.bySampleId.get(sampleId)?.recordedAt ?? '') : NaN;
    return Number.isFinite(instant) && instant >= domain.start && instant <= domain.end;
  });
  return positions.length < 2 ? null : computeBounds([{ ...geometry.path, positions }]);
}
