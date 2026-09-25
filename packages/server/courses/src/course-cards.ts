import {
  courseCardSchema,
  type CourseCard,
  type CourseCardDistanceBasis,
  type CourseCardElevation,
} from '@workout/contracts/course-cards';
import {
  sampleCourseThumbnailVertices,
  type CourseGeneration,
  type CourseReadResult,
} from '@workout/contracts/courses';

import type { ElevationIndex } from './geo-data.js';

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

export function courseCardElevation(
  revision: Extract<CourseReadResult, { status: 'available' }>['revision'],
  elevation: ElevationIndex | null,
): CourseCardElevation {
  if (elevation === null) return { status: 'not_deployed' };
  const profile = elevation.profile(revision);
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

export function courseCard(read: CourseReadResult, elevation: ElevationIndex | null): CourseCard {
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
    surface: { confirmation: 'unknown' },
  });
}
