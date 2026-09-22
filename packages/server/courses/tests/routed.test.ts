import { describe, expect, it } from 'vitest';
import type { RouteComputationRecord } from '@workout/contracts/routing';
import { courseGenerationSchema, type CourseWaypoint } from '@workout/contracts/courses';
import { maxSnapDistanceMeters, RoutedCourseError, routedCourseGeneration } from '../src/routed.js';

const computation: RouteComputationRecord = {
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: 12,
  graph: {
    engine: 'graphhopper',
    identitySource: 'engine',
    engineVersion: '10.0',
    engineArtifactSha256: 'a'.repeat(64),
    profileId: 'foot-v1',
    profileConfigSha256: 'b'.repeat(64),
    extractSha256: 'c'.repeat(64),
    extractRegion: 'seoul',
    graphContentSha256: 'd'.repeat(64),
    graphBuildId: '0123456789abcdef',
    graphImportedAt: '2026-03-01T00:00:00.000Z',
    roadDataAt: '2026-02-01T00:00:00.000Z',
  },
  conditions: {
    profileId: 'foot-v1',
    algorithm: 'flexible',
    contractionHierarchies: false,
    maxVisitedNodes: 1_000_000,
    deadlineMilliseconds: 8_000,
    snapLimitMeters: 120,
    waypointCount: 3,
  },
  computedAt: '2026-03-02T00:00:00.000Z',
  computationMilliseconds: 42,
  warnings: ['snap_distance_notable'],
};

const waypoints: CourseWaypoint[] = [
  {
    role: 'start',
    position: [126.9779, 37.5665],
    name: null,
    sourceSampleId: '0:0',
    locked: false,
  },
  { role: 'via', position: [126.9789, 37.5668], name: '중간', sourceSampleId: null, locked: true },
  {
    role: 'finish',
    position: [126.9799, 37.5671],
    name: null,
    sourceSampleId: null,
    locked: false,
  },
];

const snapped = [
  {
    requested: [126.9779, 37.5665] as [number, number],
    snapped: [126.978, 37.5666] as [number, number],
    snapDistanceMeters: 3.5,
  },
  {
    requested: [126.9789, 37.5668] as [number, number],
    snapped: [126.9789, 37.5668] as [number, number],
    snapDistanceMeters: 11.25,
  },
  {
    requested: [126.9799, 37.5671] as [number, number],
    snapped: [126.9799, 37.5671] as [number, number],
    snapDistanceMeters: 0,
  },
];

const coordinates: [number, number][] = [
  [126.9779, 37.5665],
  [126.9784, 37.5667],
  [126.9789, 37.5668],
  [126.9799, 37.5671],
];

function generation() {
  return routedCourseGeneration({
    computation,
    coordinates,
    waypoints,
    engineDistanceMeters: 1234.5,
    engineDurationSeconds: 900,
    snappedWaypoints: snapped,
  });
}

describe('routed course generation', () => {
  it('records the engine, profile and graph that actually answered', () => {
    const parsed = courseGenerationSchema.parse(generation());
    expect(parsed.kind).toBe('routed-waypoints');
    if (parsed.kind !== 'routed-waypoints') throw new Error('unreachable');
    expect(parsed.computation.graph.engine).toBe('graphhopper');
    expect(parsed.computation.graph.graphBuildId).toBe('0123456789abcdef');
    expect(parsed.computation.graph.graphContentSha256).toBe('d'.repeat(64));
    expect(parsed.computation.graph.engineVersion).toBe('10.0');
    expect(parsed.computation.conditions.maxVisitedNodes).toBe(1_000_000);
    // The draft the request belongs to, and the warnings, survive into the ledger: this is
    // the record M2-01g produced and deliberately did not store.
    expect(parsed.computation.requestRevision).toBe(12);
    expect(parsed.computation.computationMilliseconds).toBe(42);
    expect(parsed.computation.warnings).toEqual(['snap_distance_notable']);
  });

  it('keeps the engine estimate apart from anything the course itself measures', () => {
    const parsed = generation();
    if (parsed.kind !== 'routed-waypoints') throw new Error('unreachable');
    expect(parsed.engineDistanceMeters).toBe(1234.5);
    expect(parsed.engineDurationSeconds).toBe(900);
  });

  it('carries no coordinate at all', () => {
    const serialized = JSON.stringify(generation());
    expect(serialized).not.toContain('126.9');
    expect(serialized).not.toContain('37.5');
  });

  it('reports the furthest a waypoint had to move onto the network', () => {
    const parsed = generation();
    if (parsed.kind !== 'routed-waypoints') throw new Error('unreachable');
    expect(parsed.maxSnapDistanceMeters).toBe(11.25);
    expect(maxSnapDistanceMeters([])).toBe(0);
  });

  it('refuses conditions that describe a different number of waypoints', () => {
    expect(() =>
      routedCourseGeneration({
        computation: {
          ...computation,
          conditions: { ...computation.conditions, waypointCount: 2 },
        },
        coordinates,
        waypoints,
        engineDistanceMeters: 1,
        engineDurationSeconds: 1,
        snappedWaypoints: snapped,
      }),
    ).toThrow(RoutedCourseError);
  });

  it('refuses a snap report that does not cover every waypoint', () => {
    expect(() =>
      routedCourseGeneration({
        computation,
        coordinates,
        waypoints,
        engineDistanceMeters: 1,
        engineDurationSeconds: 1,
        snappedWaypoints: snapped.slice(0, 2),
      }),
    ).toThrow(RoutedCourseError);
  });

  it('refuses a geometry that is not a line', () => {
    expect(() =>
      routedCourseGeneration({
        computation,
        coordinates: [[126.9779, 37.5665]],
        waypoints,
        engineDistanceMeters: 1,
        engineDurationSeconds: 1,
        snappedWaypoints: snapped,
      }),
    ).toThrow(RoutedCourseError);
  });
});
