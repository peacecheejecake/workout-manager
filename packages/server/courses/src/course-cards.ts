import {
  courseCardSchema,
  type CourseCard,
  type CourseCardDistanceBasis,
  type CourseCardElevation,
  type CourseCardSurface,
} from '@workout/contracts/course-cards';
import {
  courseThumbnailVertexIndices,
  sampleCourseThumbnailVertices,
  type CourseGeneration,
  type CoursePosition,
  type CourseReadResult,
  type CourseThumbnailState,
} from '@workout/contracts/courses';

import type { CourseElevationResult } from '@workout/contracts/geo-data';

import { elevationProfileVertexIndices, type ElevationIndex } from './geo-data.js';

/**
 * Building one S13 list card from what the server already holds (M2-01k-a).
 *
 * Pure: the head read and the elevation index are handed in, nothing is fetched here. The
 * rules live in `@workout/contracts/course-cards`; this file only derives them, and every
 * branch that cannot know something says `unknown` or `not_deployed` rather than guessing.
 */
export function courseDistanceBasis(generation: CourseGeneration): CourseCardDistanceBasis {
  switch (generation.kind) {
    case 'recorded-segment':
      return { kind: 'recorded' };
    case 'routed-waypoints':
    case 'target-distance-loop':
      return {
        kind: 'engine-estimate',
        engineDistanceMeters: generation.engineDistanceMeters,
        graphBuildId: generation.computation.graph.graphBuildId,
      };
    case 'imported-file':
      return { kind: 'imported-file', sourceKind: generation.sourceKind };
    case 'privacy-trimmed':
      // The trimmed line is part of the line it came from, so it keeps that line's nature —
      // but not the engine's figure, which described the untrimmed line.
      switch (generation.sourceGenerationKind) {
        case 'recorded-segment':
          return { kind: 'recorded' };
        case 'routed-waypoints':
        case 'target-distance-loop':
          return {
            kind: 'engine-estimate',
            engineDistanceMeters: null,
            graphBuildId: generation.sourceGraphBuildId,
          };
        case 'imported-file':
          return { kind: 'imported-file', sourceKind: null };
        // A trim of a trim no longer records what the first line was.
        case 'privacy-trimmed':
          return { kind: 'unknown' };
      }
  }
}

/** Only a saved v2 candidate has path-detail provenance; absence is never a negative fact. */
export function courseCardSurface(generation: CourseGeneration): CourseCardSurface {
  if (generation.kind !== 'target-distance-loop') return { confirmation: 'unknown' };
  if (generation.evaluation.evaluationVersion !== 2) return { confirmation: 'unknown' };
  const fact = generation.evaluation.knowledge.surface;
  if (fact.status !== 'reported') return { confirmation: 'unknown' };
  const known = fact.known.filter((entry) => entry.meters > 0);
  if (known.length === 0) return { confirmation: 'unknown' };
  return {
    confirmation: 'graph-reported',
    graphBuildId: generation.computation.graph.graphBuildId,
    known,
    unknownMeters: fact.unknownMeters,
  };
}

export function courseCardElevation(
  revision: Extract<CourseReadResult, { status: 'available' }>['revision'],
  elevation: ElevationIndex | null,
): CourseCardElevation {
  if (elevation === null) return { status: 'not_deployed' };
  return cardElevationOf(elevation.profile(revision));
}

function cardElevationOf(profile: CourseElevationResult): CourseCardElevation {
  switch (profile.outcome) {
    case 'no_dataset':
      return { status: 'not_deployed' };
    case 'outside_region':
      return { status: 'outside_region', dataset: profile.dataset };
    case 'profile':
      return {
        status: 'sampled',
        dataset: profile.dataset,
        sampledCount: profile.points.length,
        knownCount: profile.knownCount,
        maxSourceDistanceMeters: profile.maxSourceDistanceMeters,
      };
  }
}

/**
 * The card of one whole head read. Since M2-01an the list route builds cards with
 * `courseCardFromSource`; this stays as the definition that one is held to (the contract
 * test in the persistence integration suite compares the two on the same stored courses).
 */
export function courseCard(
  read: CourseReadResult,
  elevation: ElevationIndex | null,
  graphSurface = false,
): CourseCard {
  if (read.status === 'unavailable')
    return courseCardSchema.parse({ status: 'unavailable', course: read.course });
  const { revision } = read;
  return courseCardSchema.parse({
    status: 'available',
    course: read.course,
    distance: {
      plannedLineMeters: revision.distanceMeters,
      basis: courseDistanceBasis(revision.generation),
      privacyTrimmed: revision.generation.kind === 'privacy-trimmed',
    },
    thumbnail: {
      state: read.thumbnail,
      drawnVertices: sampleCourseThumbnailVertices(revision.geometry.coordinates),
    },
    elevation: courseCardElevation(revision, elevation),
    surface: graphSurface ? courseCardSurface(revision.generation) : { confirmation: 'unknown' },
  });
}

/**
 * What storage hands over for one card when it does not read the whole line (M2-01an).
 *
 * A card needs the head, the generation, the planned length, the head revision's thumbnail
 * state and — from the line itself — only its vertex count, the vertices at
 * `courseCardVertexIndices`, and whether any vertex lies inside the elevation dataset's box.
 * Reading all 20,000 vertices of 200 courses to use at most 600 of each was the whole cost
 * of the card list; this is the same card without it.
 */
export type CourseCardSource =
  | {
      readonly status: 'unavailable';
      readonly course: Extract<CourseReadResult, { status: 'unavailable' }>['course'];
    }
  | {
      readonly status: 'available';
      readonly course: Extract<CourseReadResult, { status: 'available' }>['course'];
      readonly generation: CourseGeneration;
      readonly distanceMeters: number;
      readonly thumbnail: CourseThumbnailState;
      readonly line: {
        readonly vertexCount: number;
        /** Exactly the vertices `courseCardVertexIndices(vertexCount, …)` names. */
        readonly vertices: ReadonlyMap<number, CoursePosition>;
        /** Whether any vertex lies inside the elevation box; `null` when none was asked. */
        readonly touchesRegion: boolean | null;
      };
    };

/**
 * The vertices a card of a line of `vertexCount` looks at, ascending and without repeats:
 * the thumbnail's stride, and the elevation profile's when this server has a dataset.
 */
export function courseCardVertexIndices(
  vertexCount: number,
  elevation: ElevationIndex | null,
): readonly number[] {
  const wanted = new Set(courseThumbnailVertexIndices(vertexCount));
  if (elevation !== null)
    for (const vertexIndex of elevationProfileVertexIndices(vertexCount)) wanted.add(vertexIndex);
  return [...wanted].sort((left, right) => left - right);
}

/**
 * The same card `courseCard` builds from a whole head read, built from a card source.
 * A vertex the source was asked for and does not hold is a broken read, not an unknown.
 */
export function courseCardFromSource(
  source: CourseCardSource,
  elevation: ElevationIndex | null,
  graphSurface = false,
): CourseCard {
  if (source.status === 'unavailable')
    return courseCardSchema.parse({ status: 'unavailable', course: source.course });
  const { line } = source;
  const vertexAt = (vertexIndex: number): CoursePosition => {
    const position = line.vertices.get(vertexIndex);
    if (position === undefined) throw new Error('COURSE_CARD_VERTEX_MISSING');
    return position;
  };
  let cardElevation: CourseCardElevation = { status: 'not_deployed' };
  if (elevation !== null) {
    if (line.touchesRegion === null) throw new Error('COURSE_CARD_REGION_NOT_READ');
    cardElevation = cardElevationOf(
      elevation.profileOfSample({
        vertexCount: line.vertexCount,
        touchesRegion: line.touchesRegion,
        positionAt: vertexAt,
      }),
    );
  }
  return courseCardSchema.parse({
    status: 'available',
    course: source.course,
    distance: {
      plannedLineMeters: source.distanceMeters,
      basis: courseDistanceBasis(source.generation),
      privacyTrimmed: source.generation.kind === 'privacy-trimmed',
    },
    thumbnail: {
      state: source.thumbnail,
      drawnVertices: courseThumbnailVertexIndices(line.vertexCount).map(vertexAt),
    },
    elevation: cardElevation,
    surface: graphSurface ? courseCardSurface(source.generation) : { confirmation: 'unknown' },
  });
}
