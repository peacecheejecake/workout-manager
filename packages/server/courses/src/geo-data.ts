import { courseLimits, type CoursePosition, type CourseRevision } from '@workout/contracts/courses';
import {
  courseElevationResultSchema,
  placeSearchResultSchema,
  type CourseElevationResult,
  type ElevationDatasetDocument,
  type PlaceDatasetDocument,
  type PlaceSearchRequest,
  type PlaceSearchResult,
} from '@workout/contracts/geo-data';

import { greatCircleMeters } from './geo.js';

/**
 * Searching and sampling our own geo datasets (M2-01j).
 *
 * Both indexes are built from a dataset document that the build produced from the same
 * regional extract as the basemap and the routing graph. There is no network call in this
 * file and no second source: when a dataset is absent the answer is `no_dataset`, and when
 * a query falls outside the region the dataset covers the answer is `outside_region`.
 * Neither is ever reported as "no results" or as zero.
 */

/** Fold width, case and accents so a Korean or English query matches the same way twice. */
function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function withinBbox(position: CoursePosition, bbox: readonly number[]): boolean {
  const [west, south, east, north] = bbox as [number, number, number, number];
  return position[0] >= west && position[0] <= east && position[1] >= south && position[1] <= north;
}

export interface PlaceIndex {
  readonly identity: PlaceDatasetDocument['identity'];
  search(request: PlaceSearchRequest): PlaceSearchResult;
}

/**
 * A linear scan over the folded names, bounded by the dataset's own size and by the result
 * limit. The region this product self-hosts is a city extract with a few thousand named
 * places; a larger dataset needs a real index and this is where that would go.
 */
export function createPlaceIndex(document: PlaceDatasetDocument): PlaceIndex {
  const entries = document.places.map((place) => ({
    place,
    folded: fold(place.name),
    foldedLocal: place.localName === null ? null : fold(place.localName),
  }));
  return {
    identity: document.identity,
    search(request) {
      if (request.near !== null && !withinBbox(request.near, document.identity.bbox))
        return placeSearchResultSchema.parse({
          outcome: 'outside_region',
          dataset: document.identity,
        });
      const needle = fold(request.query);
      if (needle === '')
        return placeSearchResultSchema.parse({
          outcome: 'results',
          dataset: document.identity,
          places: [],
          matchCount: 0,
        });
      const near = request.near;
      const matched = entries
        .map((entry) => {
          const inName = entry.folded.indexOf(needle);
          const inLocal = entry.foldedLocal === null ? -1 : entry.foldedLocal.indexOf(needle);
          if (inName < 0 && inLocal < 0) return null;
          const position = inName < 0 ? inLocal : inLocal < 0 ? inName : Math.min(inName, inLocal);
          const exact = entry.folded === needle || entry.foldedLocal === needle;
          return {
            entry,
            rank: exact ? 0 : position === 0 ? 1 : 2,
            distanceMeters: near === null ? null : greatCircleMeters(near, entry.place.position),
          };
        })
        .filter((value): value is NonNullable<typeof value> => value !== null);
      matched.sort((left, right) => {
        if (left.rank !== right.rank) return left.rank - right.rank;
        if (left.distanceMeters !== null && right.distanceMeters !== null)
          return left.distanceMeters - right.distanceMeters;
        if (left.entry.place.name !== right.entry.place.name)
          return left.entry.place.name.length - right.entry.place.name.length;
        return left.entry.place.placeId < right.entry.place.placeId ? -1 : 1;
      });
      return placeSearchResultSchema.parse({
        outcome: 'results',
        dataset: document.identity,
        matchCount: matched.length,
        places: matched.slice(0, courseLimits.placeResults).map((match) => ({
          ...match.entry.place,
          distanceMeters: match.distanceMeters,
        })),
      });
    },
  };
}

export interface ElevationIndex {
  readonly identity: ElevationDatasetDocument['identity'];
  profile(revision: Pick<CourseRevision, 'geometry'>): CourseElevationResult;
}

const CELL_DEGREES = 0.01;

/**
 * Elevation from our own dataset, and only where it actually has a fact.
 *
 * The dataset is built from the `ele` tags of our own extract, which are sparse by nature:
 * summits, survey points, some stations. The honest consequence is that most vertices have
 * no elevation, and this index says `null` for them. It never interpolates between two
 * known points, never substitutes zero and never reports a total ascent — a sum over a
 * sparse sample would be a number nobody measured.
 */
export function createElevationIndex(document: ElevationDatasetDocument): ElevationIndex {
  const cells = new Map<string, { position: CoursePosition; elevationMeters: number }[]>();
  // The extent of the cells that actually hold something, accumulated as they are filled.
  //
  // Deliberately NOT the declared bounding box. Nothing enforces that a dataset's points
  // lie inside the box it declares — the contract has no such refinement and the builder
  // copies a hard-coded rectangle rather than clipping to it — and in this product's own
  // artifact 232 of 821 elevation points are outside it. Clamping the scan to the declared
  // box therefore silently turned a known elevation into "unknown" on the built dataset.
  // Two independent probes agreed that one fact was lost and disagreed on how many
  // out-of-box points are reachable at all (4 versus 8), because that total depends on
  // which legal position inside the box you probe from; the loss is the part that
  // reproduces, so it is the part quoted here. Clamping to the filled cells instead is
  // true **by construction**, because these numbers are derived from the points themselves.
  //
  // What the clamp is for is cost, not correctness: at the contract's widest radius
  // (10 km) near a pole the cosine below asks for a ring about 900 cells across, which is
  // ~1.6 million lookups per vertex and 200 vertices per profile. Bounded by the filled
  // extent, a scan can never exceed the cells the dataset actually occupies.
  let minCellX = Number.POSITIVE_INFINITY;
  let maxCellX = Number.NEGATIVE_INFINITY;
  let minCellY = Number.POSITIVE_INFINITY;
  let maxCellY = Number.NEGATIVE_INFINITY;
  for (const point of document.points) {
    const cellX = Math.floor(point.position[0] / CELL_DEGREES);
    const cellY = Math.floor(point.position[1] / CELL_DEGREES);
    if (cellX < minCellX) minCellX = cellX;
    if (cellX > maxCellX) maxCellX = cellX;
    if (cellY < minCellY) minCellY = cellY;
    if (cellY > maxCellY) maxCellY = cellY;
    const key = `${cellX}:${cellY}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(point);
    else cells.set(key, [point]);
  }
  const radius = document.maxSourceDistanceMeters;
  const METRES_PER_DEGREE = 111_000;
  // How many cells north and south to look so that nothing inside the radius is missed.
  // A degree of latitude is about 111 km everywhere, so this one is generous as written.
  const spanY = Math.max(1, Math.ceil(radius / (CELL_DEGREES * METRES_PER_DEGREE)));

  function nearest(position: CoursePosition): { elevationMeters: number; distance: number } | null {
    const baseX = Math.floor(position[0] / CELL_DEGREES);
    const baseY = Math.floor(position[1] / CELL_DEGREES);
    // East and west is a different question, and using the latitude figure for it was
    // wrong rather than generous: a cell is `cos(latitude)` as wide as it is tall, so at
    // 37.5° it is 880 m rather than 1,110 m and at 80° it is 193 m. With a wide radius the
    // ring stopped short of it and a point inside the radius was reported as unknown. The
    // cosine is floored so the poles cannot ask for an unbounded ring.
    const spanX = Math.max(
      1,
      Math.ceil(
        radius /
          (CELL_DEGREES *
            METRES_PER_DEGREE *
            Math.max(Math.cos((position[1] * Math.PI) / 180), 0.01)),
      ),
    );
    let best: { elevationMeters: number; distance: number } | null = null;
    const fromX = Math.max(baseX - spanX, minCellX);
    const toX = Math.min(baseX + spanX, maxCellX);
    const fromY = Math.max(baseY - spanY, minCellY);
    const toY = Math.min(baseY + spanY, maxCellY);
    for (let cellX = fromX; cellX <= toX; cellX += 1)
      for (let cellY = fromY; cellY <= toY; cellY += 1) {
        const bucket = cells.get(`${cellX}:${cellY}`);
        if (!bucket) continue;
        for (const point of bucket) {
          const distance = greatCircleMeters(point.position, position);
          if (distance > radius) continue;
          if (best === null || distance < best.distance)
            best = { elevationMeters: point.elevationMeters, distance };
        }
      }
    return best;
  }

  return {
    identity: document.identity,
    profile(revision) {
      const coordinates = revision.geometry.coordinates;
      if (!coordinates.some((position) => withinBbox(position, document.identity.bbox)))
        return courseElevationResultSchema.parse({
          outcome: 'outside_region',
          dataset: document.identity,
        });
      // A long course is sampled at an even stride rather than summarised: the reader sees
      // which vertices were looked at, and the vertex count of the whole line.
      const wanted = Math.min(coordinates.length, courseLimits.elevationProfilePoints);
      const indices =
        wanted >= coordinates.length
          ? coordinates.map((_, index) => index)
          : Array.from({ length: wanted }, (_, step) =>
              Math.round((step * (coordinates.length - 1)) / (wanted - 1)),
            );
      const points = indices.map((vertexIndex) => {
        const position = coordinates[vertexIndex];
        const found = position === undefined ? null : nearest(position);
        return {
          vertexIndex,
          elevationMeters: found?.elevationMeters ?? null,
          sourceDistanceMeters: found?.distance ?? null,
        };
      });
      return courseElevationResultSchema.parse({
        outcome: 'profile',
        dataset: document.identity,
        maxSourceDistanceMeters: radius,
        points,
        knownCount: points.filter((point) => point.elevationMeters !== null).length,
        vertexCount: coordinates.length,
      });
    },
  };
}
