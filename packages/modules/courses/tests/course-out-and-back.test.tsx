import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  courseRouteKnowledgeSchema,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { createCourseDraftStore, currentOutAndBack } from '../src/course-draft';
import { draftMapPaths } from '../src/course-draft-context';
import { CourseWorkbench } from '../src/course-workbench';
import {
  accessRestrictionsText,
  nightAccessText,
  stairsText,
  surfaceText,
} from '../src/course-out-and-back';
import {
  analyseOutAndBack,
  isOutAndBack,
  lineMeters,
  metersBetween,
  outAndBackOverlap,
  turnaroundIndex,
} from '../src/out-and-back';

/**
 * M2-01k-j: the out-and-back (A→B→A) draft and the overlap of its two legs.
 *
 * The geometry is local to Seoul City Hall so the metres are real metres. A is the start,
 * B the turnaround about 353 m east of it, and the "north" line runs 111 m north of the A–B street.
 */
const A: CoursePosition = [126.9779, 37.5665];
const M: CoursePosition = [126.9799, 37.5665];
const B: CoursePosition = [126.9819, 37.5665];
const northOf = (position: CoursePosition): CoursePosition => [position[0], position[1] + 0.001];

describe('out-and-back overlap', () => {
  it('reports the whole way back when it retraces the way out, however the straight street is split', () => {
    const out: CoursePosition[] = [A, M, B];
    // The same street, split at different vertices: the answer is about the line.
    const back: CoursePosition[] = [B, [126.9809, 37.5665], [126.9789, 37.5665], A];
    const overlap = outAndBackOverlap(out, back);
    expect(overlap.outMeters).toBeCloseTo(lineMeters(out), 6);
    expect(overlap.backMeters).toBeCloseTo(metersBetween(A, B), 3);
    expect(overlap.overlapRatio).toBeCloseTo(1, 6);
    expect(overlap.overlapMeters).toBeCloseTo(overlap.backMeters, 3);
    expect(overlap.segments).toHaveLength(1);
    const [segment] = overlap.segments;
    expect(segment?.fromMeters).toBe(0);
    expect(segment?.toMeters).toBeCloseTo(overlap.backMeters, 3);
    expect(segment?.positions[0]).toEqual(B);
    expect(segment?.positions.at(-1)).toEqual(A);
  });

  it('reports only the shared stretch when the way back leaves the street halfway', () => {
    const out: CoursePosition[] = [A, M, B];
    // Back along the street to M, then up to the parallel street and home along it.
    const back: CoursePosition[] = [B, M, northOf(M), northOf(A), A];
    const overlap = outAndBackOverlap(out, back);
    const shared = metersBetween(B, M);
    expect(overlap.segments).toHaveLength(1);
    // The shared stretch runs from the turnaround to M, plus at most the tolerance where the
    // leg to the north still lies within it of the street.
    const [segment] = overlap.segments;
    expect(segment?.fromMeters).toBe(0);
    expect(overlap.overlapMeters).toBeGreaterThanOrEqual(shared - 4);
    expect(overlap.overlapMeters).toBeLessThanOrEqual(shared + 16);
    expect(overlap.overlapRatio).toBeCloseTo(overlap.overlapMeters / lineMeters(back), 6);
    expect(overlap.overlapRatio).toBeGreaterThan(0.25);
    expect(overlap.overlapRatio).toBeLessThan(0.4);
  });

  it('reports nothing when the way back takes another street, even though both touch A and B', () => {
    const out: CoursePosition[] = [A, M, B];
    const back: CoursePosition[] = [B, northOf(B), northOf(M), northOf(A), A];
    const overlap = outAndBackOverlap(out, back);
    expect(overlap.segments).toEqual([]);
    expect(overlap.overlapMeters).toBe(0);
    expect(overlap.overlapRatio).toBe(0);
    expect(overlap.backMeters).toBeGreaterThan(overlap.outMeters);
  });

  it('does not count a way back that only crosses the way out', () => {
    // Out along the street; back on a different path that crosses it at 90° halfway.
    const out: CoursePosition[] = [A, M, B];
    const south: CoursePosition = [M[0], M[1] - 0.001];
    const back: CoursePosition[] = [B, northOf(B), northOf(M), south, [A[0], south[1]], A];
    const overlap = outAndBackOverlap(out, back);
    // The crossing lies within the tolerance for 24 m of the way back, and the legs to and
    // from A and B touch the street too. None of it runs along the street.
    expect(overlap.segments).toEqual([]);
    expect(overlap.overlapMeters).toBe(0);
  });

  it('does not count a way back that leaves the turnaround at a shallow angle on another street', () => {
    const out: CoursePosition[] = [A, M, B];
    // 30° off the street for 200 m, then home on the parallel street to the north.
    const east = (200 * Math.cos(Math.PI / 6)) / (111_320 * Math.cos((B[1] * Math.PI) / 180));
    const north = (200 * Math.sin(Math.PI / 6)) / 111_320;
    const departed: CoursePosition = [B[0] - east, B[1] + north];
    const back: CoursePosition[] = [B, departed, [A[0], departed[1]], A];
    const overlap = outAndBackOverlap(out, back);
    expect(overlap.segments).toEqual([]);
  });

  it('splits a computed line at the snapped turnaround and measures each leg', () => {
    const coordinates: CoursePosition[] = [A, M, B, M, A];
    expect(turnaroundIndex(coordinates, B)).toBe(2);
    // A turnaround reported off the line falls back to the nearest inner vertex.
    expect(turnaroundIndex(coordinates, [B[0] + 0.0001, B[1]])).toBe(2);
    const waypoints = [A, B, A];
    expect(isOutAndBack(waypoints)).toBe(true);
    expect(isOutAndBack([A, B])).toBe(false);
    expect(isOutAndBack([A, B, M])).toBe(false);
    expect(isOutAndBack([A, A, A])).toBe(false);
    const analysis = analyseOutAndBack({ coordinates, waypoints, snappedWaypoints: [A, B, A] });
    expect(analysis?.turnaroundIndex).toBe(2);
    expect(analysis?.overlapRatio).toBeCloseTo(1, 6);
    // A one-way draft is not an out-and-back, whatever its line looks like.
    expect(analyseOutAndBack({ coordinates, waypoints: [A, B] })).toBeNull();
  });
});

const seed: CourseWaypoint[] = [
  { role: 'start', position: A, name: '시청', sourceSampleId: '0:0', locked: true },
  { role: 'finish', position: B, name: null, sourceSampleId: '0:3', locked: false },
];

describe('out-and-back draft', () => {
  it('makes A→B→A from the start and the finish as one undoable change', () => {
    const store = createCourseDraftStore({ courseId: 'c', headRevision: 1, waypoints: seed });
    expect(store.getState().makeOutAndBack()).toBeNull();
    const state = store.getState();
    expect(state.revision).toBe(2);
    expect(state.waypoints.map((waypoint) => [waypoint.role, waypoint.position])).toEqual([
      ['start', A],
      ['via', B],
      ['finish', A],
    ]);
    // The return to A is a planned point: it claims no recorded sample and no lock.
    expect(state.waypoints[2]).toMatchObject({ name: '시청', sourceSampleId: null, locked: false });
    // Already an out-and-back: nothing changes and no revision is spent.
    expect(store.getState().makeOutAndBack()).toBeNull();
    expect(store.getState().revision).toBe(2);
    store.getState().undo();
    expect(store.getState().waypoints.map((waypoint) => waypoint.position)).toEqual([A, B]);
  });

  it('refuses rather than dropping a pinned via or turning around at the start', () => {
    const store = createCourseDraftStore({ courseId: 'c', headRevision: 1, waypoints: seed });
    store.getState().addVia(M);
    const via = store.getState().waypoints[1];
    if (!via) throw new Error('missing via');
    store.getState().setLocked(via.id, true);
    const before = store.getState().revision;
    expect(store.getState().makeOutAndBack()).toBe('OUT_AND_BACK_LOCKED_VIA');
    expect(store.getState().revision).toBe(before);
    const same = createCourseDraftStore({
      courseId: 'c',
      headRevision: 1,
      waypoints: [seed[0] as CourseWaypoint, { ...(seed[1] as CourseWaypoint), position: A }],
    });
    expect(same.getState().makeOutAndBack()).toBe('OUT_AND_BACK_SAME_POINT');
  });

  it('draws the stretches walked twice as their own map path over the proposal', () => {
    const store = createCourseDraftStore({ courseId: 'c', headRevision: 1, waypoints: seed });
    store.getState().makeOutAndBack();
    store.getState().applyRoute({
      draftRevision: store.getState().revision,
      proposalId: 'p',
      coordinates: [A, M, B, [126.9809, 37.5665], A],
      engineDistanceMeters: 704,
      engineDurationSeconds: 500,
      maxSnapDistanceMeters: 0,
      graphBuildId: '0123456789abcdef',
      engineVersion: '10.0',
      computedAt: '2026-03-02T00:00:00.000Z',
      warnings: [],
      snappedWaypoints: [A, B, A],
    });
    expect(currentOutAndBack(store.getState())?.segments).toHaveLength(1);
    const overlap = draftMapPaths({ state: store.getState(), storedCoordinates: [] }).find(
      (path) => path.id === 'course-overlap',
    );
    expect(overlap?.role).toBe('overlap');
    expect(overlap?.positions[0]).toEqual(B);
    expect(overlap?.positions.at(-1)).toEqual(A);
    // Moving on from the draft takes the overlap with it: it belonged to that answer.
    store.getState().addVia(M);
    expect(
      draftMapPaths({ state: store.getState(), storedCoordinates: [] }).some(
        (path) => path.role === 'overlap',
      ),
    ).toBe(false);
  });
});

// ── The editor: the out-and-back button, the request it sends and the review it shows.

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const courseId = '11111111-1111-4111-8111-111111111111';
const proposalId = '66666666-6666-4666-8666-666666666666';
const createdAt = '2026-03-01T00:00:00.000Z';
const graph = {
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
  graphImportedAt: createdAt,
  roadDataAt: createdAt,
};
const head = {
  status: 'available',
  courseId,
  name: 'Seoul out and back',
  visibility: 'private',
  headRevision: 2,
  revisionId: '55555555-5555-4555-8555-555555555555',
  createdAt,
  updatedAt: createdAt,
};
const revision = {
  courseId,
  courseRevision: 2,
  revisionId: head.revisionId,
  name: head.name,
  geometry: { type: 'LineString', coordinates: [A, B] },
  waypoints: [
    { role: 'start', position: A, name: null, sourceSampleId: null },
    { role: 'finish', position: B, name: null, sourceSampleId: null },
  ],
  generation: {
    kind: 'recorded-segment',
    activityId: '33333333-3333-4333-8333-333333333333',
    trackId: '44444444-4444-4444-8444-444444444444',
    trackRevision: 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: '0:3',
    vertexCount: 2,
    mapPathContentSha256: 'a'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 2.5,
  },
  edit: { kind: 'created' },
  lineage: [
    {
      activityId: '33333333-3333-4333-8333-333333333333',
      trackId: '44444444-4444-4444-8444-444444444444',
      trackRevision: 1,
    },
  ],
  distanceMeters: 352,
  contentDigest: 'b'.repeat(64),
  createdAt,
};

/**
 * What the engine reported about the edges of the answer (M2-01ap): two short stairways, two
 * surfaces and one private stretch on record, and some of the line with nothing on record.
 */
const sampleKnowledge = {
  stairs: {
    status: 'reported',
    known: [
      { value: 'not_steps', meters: 600.4, sections: 1 },
      { value: 'steps', meters: 38.2, sections: 2 },
    ],
    unknownMeters: 12.5,
  },
  surface: {
    status: 'reported',
    known: [
      { value: 'paving_stones', meters: 420, sections: 3 },
      { value: 'asphalt', meters: 180.6, sections: 1 },
    ],
    unknownMeters: 50.5,
  },
  accessRestrictions: {
    status: 'reported',
    known: [{ value: 'road_access=private', meters: 24.6, sections: 1 }],
    unknownMeters: 626.5,
  },
  nightAccess: 'unknown',
  gradient: 'unknown',
} as const;

const unreportedKnowledge = {
  stairs: { status: 'not_reported' },
  surface: { status: 'not_reported' },
  accessRestrictions: { status: 'not_reported' },
  nightAccess: 'unknown',
  gradient: 'unknown',
} as const;

/** The engine's answer to whatever was asked: out along the street, back along the same one. */
function answer(input: TransportRequest, knowledge: unknown = sampleKnowledge) {
  const asked = input.body as {
    requestId: string;
    draftRevision: number;
    waypoints: CourseWaypoint[];
  };
  const positions = asked.waypoints.map((waypoint) => waypoint.position);
  const coordinates: CoursePosition[] = [];
  for (const [index, position] of positions.entries()) {
    const previous = positions[index - 1];
    if (previous !== undefined)
      coordinates.push([(previous[0] + position[0]) / 2, (previous[1] + position[1]) / 2]);
    coordinates.push(position);
  }
  return reply({
    outcome: 'route_computed',
    knowledge,
    proposal: {
      proposalId,
      courseId,
      requestId: asked.requestId,
      draftRevision: asked.draftRevision,
      waypoints: asked.waypoints,
      geometry: { type: 'LineString', coordinates },
      engineDistanceMeters: 5_120,
      engineDurationSeconds: 900,
      snappedWaypoints: positions.map((position) => ({
        requested: position,
        snapped: position,
        snapDistanceMeters: 0,
      })),
      computation: {
        schemaVersion: 1,
        requestId: asked.requestId,
        requestRevision: asked.draftRevision,
        graph,
        conditions: {
          profileId: 'foot-v1',
          algorithm: 'flexible',
          contractionHierarchies: false,
          maxVisitedNodes: 1_000_000,
          deadlineMilliseconds: 8_000,
          snapLimitMeters: 120,
          waypointCount: positions.length,
        },
        computedAt: '2026-03-02T00:00:00.000Z',
        computationMilliseconds: 12,
        warnings: [],
      },
      createdAt,
      expiresAt: '2026-03-01T00:30:00.000Z',
    },
  });
}

function FakeMap(props: MapViewProps) {
  return (
    <ul aria-label="지도 대역">
      {props.paths.map((path) => (
        <li key={path.id} data-role={path.role}>
          {path.id}
        </li>
      ))}
    </ul>
  );
}

function setup(knowledge: unknown = sampleKnowledge) {
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    if (input.path === `/bff/v1/courses/${courseId}/route-proposals`)
      return answer(input, knowledge);
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: [head], total: 1 });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({ status: 'available', course: head, revision, thumbnail: { status: 'none' } });
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  render(
    <CourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      mapView={FakeMap}
    />,
  );
  return request;
}

describe('out-and-back in the editor', () => {
  it('asks the engine for A→B→A and shows the overlap, the target error, what the graph records and the unknowns', async () => {
    const request = setup();
    await userEvent.click(await screen.findByRole('button', { name: head.name }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: '왕복 초안 계산 (A→B→A)' }));
    const review = await screen.findByTestId('out-and-back-review');

    const sent = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.path.endsWith('/route-proposals'));
    const body = sent?.body as { waypoints: CourseWaypoint[] };
    expect(body.waypoints.map((waypoint) => [waypoint.role, waypoint.position])).toEqual([
      ['start', A],
      ['via', B],
      ['finish', A],
    ]);

    // The fake engine retraced the street, so the whole way back is shared.
    const leg = Math.round(metersBetween(A, B));
    expect(within(review).getByTestId('route-overlap')).toHaveTextContent(`${leg}m (100%) · 1곳`);
    expect(within(review).getByRole('list', { name: '겹치는 구간' })).toHaveTextContent(
      `1구간 · 오는 길 0m–${leg}m 지점`,
    );
    // 5,120 m against the default 5,000 m target in the field.
    expect(within(review).getByTestId('route-target-error')).toHaveTextContent('+120m (2.4%)');
    expect(within(review).getByTestId('route-connectivity')).toHaveTextContent(
      '엔진이 지났다고 밝힌 도로 구간으로 이어짐',
    );
    // What the graph records along the line, and the rest said to be unknown, with why.
    expect(within(review).getByTestId('route-access')).toHaveTextContent(
      'road_access=private(사유) 25m · 1곳 · 확인되지 않음 627m (graph에 제한 값 없음 · 제한이 없다는 확인은 아님)',
    );
    expect(within(review).getByTestId('route-stairs')).toHaveTextContent(
      '계단 2곳 38m (highway=steps) · 계단 아닌 길 600m · 확인되지 않음 13m (도로 등급 미상)',
    );
    expect(within(review).getByTestId('route-surface')).toHaveTextContent(
      '보도블록(paving_stones) 420m · 아스팔트(asphalt) 181m · 확인되지 않음 51m (graph에 노면 값 없음)',
    );
    expect(within(review).getByTestId('route-night')).toHaveTextContent(
      '확인되지 않음 (자료 없음)',
    );
    expect(review).toHaveTextContent('road_access는 차량·일반 access 태그에서 온 값이라');
    expect(within(review).getByTestId('route-gradient')).toHaveTextContent(
      '확인되지 않음 (엔진 경사 자료 없음 · 고도 표본은 고도 확인 참조)',
    );
    // The legs are line lengths, and are labelled so.
    expect(review).toHaveTextContent('가는 길 선 길이 (A→B)');
    expect(within(review).queryByTestId('out-and-back-dropped')).toBeNull();
    // And the map was handed the stretch walked twice as its own path.
    const map = screen.getByRole('list', { name: '지도 대역' });
    expect(within(map).getByText('course-overlap')).toHaveAttribute('data-role', 'overlap');
  });

  it('says the engine did not answer rather than showing a clean line', async () => {
    setup(unreportedKnowledge);
    await userEvent.click(await screen.findByRole('button', { name: head.name }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: '왕복 초안 계산 (A→B→A)' }));
    const review = await screen.findByTestId('out-and-back-review');
    for (const id of ['route-access', 'route-stairs', 'route-surface'])
      expect(within(review).getByTestId(id)).toHaveTextContent(
        '확인되지 않음 (엔진이 이 경로의 값을 답하지 않음)',
      );
  });

  it('says so when making the out-and-back left a via waypoint out', async () => {
    const request = setup();
    await userEvent.click(await screen.findByRole('button', { name: head.name }));
    const editor = await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(within(editor).getByLabelText('경유점 경도'), String(M[0]));
    await userEvent.type(within(editor).getByLabelText('경유점 위도'), String(M[1]));
    await userEvent.click(within(editor).getByRole('button', { name: '좌표로 경유점 추가' }));
    await userEvent.click(screen.getByRole('button', { name: '왕복 초안 계산 (A→B→A)' }));
    const review = await screen.findByTestId('out-and-back-review');
    expect(within(review).getByTestId('out-and-back-dropped')).toHaveTextContent(
      '사이의 경유점 1개를 뺐습니다',
    );
    const sent = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.path.endsWith('/route-proposals'));
    expect((sent?.body as { waypoints: CourseWaypoint[] }).waypoints).toHaveLength(3);
  });
});

describe('the stairs, surface and access lines (M2-01ap)', () => {
  const reported = (
    stairs: unknown,
    surface: unknown = { status: 'reported', known: [], unknownMeters: 0 },
    accessRestrictions: unknown = { status: 'reported', known: [], unknownMeters: 0 },
  ) =>
    courseRouteKnowledgeSchema.parse({
      stairs,
      surface,
      accessRestrictions,
      nightAccess: 'unknown',
      gradient: 'unknown',
    });

  it('says a line with no stairway class has none by class, and keeps the unknown apart', () => {
    const knowledge = reported({
      status: 'reported',
      known: [{ value: 'not_steps', meters: 1_460, sections: 1 }],
      unknownMeters: 20,
    });
    expect(stairsText(knowledge)).toBe(
      '도로 등급에 계단 없음 1.46km · 확인되지 않음 20m (도로 등급 미상)',
    );
  });

  it('never calls a wholly unknown line clean', () => {
    const knowledge = reported(
      { status: 'reported', known: [], unknownMeters: 800 },
      { status: 'reported', known: [], unknownMeters: 800 },
      { status: 'reported', known: [], unknownMeters: 800 },
    );
    expect(stairsText(knowledge)).toBe('확인되지 않음 800m (도로 등급 미상)');
    expect(surfaceText(knowledge)).toBe('확인되지 않음 800m (graph에 노면 값 없음)');
    expect(accessRestrictionsText(knowledge)).toBe(
      '확인되지 않음 800m (graph에 제한 값 없음 · 제한이 없다는 확인은 아님)',
    );
    expect(nightAccessText(knowledge)).toBe('확인되지 않음 (자료 없음)');
  });

  it('shows a restriction the graph records against walking as a foot restriction', () => {
    const knowledge = reported({ status: 'reported', known: [], unknownMeters: 0 }, undefined, {
      status: 'reported',
      known: [{ value: 'foot_access=no', meters: 12.4, sections: 1 }],
      unknownMeters: 0,
    });
    expect(accessRestrictionsText(knowledge)).toBe('foot_access=no(도보 금지) 12m · 1곳');
  });
});
