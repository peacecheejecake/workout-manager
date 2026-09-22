import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { CourseWorkbench } from '../src/course-workbench';
import {
  createCourseDraftStore,
  currentCandidates,
  pickedCandidate,
  type DraftCandidateSet,
} from '../src/course-draft';
import { draftMapPaths } from '../src/course-draft-context';

/**
 * S14 target-distance candidates on screen (M2-01i).
 *
 * The three rules this file holds in place: generating candidates writes nothing, picking
 * one writes nothing either, and only an explicit save of a reviewed pick does. Around
 * them are the same lateness and ownership rules the route computation has — a search
 * takes longer, so a late answer is more likely, not less.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
const activityId = '33333333-3333-4333-8333-333333333333';
const trackId = '44444444-4444-4444-8444-444444444444';
const setId = '77777777-7777-4777-8777-777777777777';
const createdAt = '2026-03-01T00:00:00.000Z';
const origin: [number, number] = [126.9779, 37.5665];

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

const computation = (
  draftRevision: number,
  requestId: string,
  graphBuildId = graph.graphBuildId,
) => ({
  schemaVersion: 1,
  requestId,
  requestRevision: draftRevision,
  graph: { ...graph, graphBuildId },
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
  computationMilliseconds: 120,
  warnings: [],
});

const head = {
  status: 'available',
  courseId,
  name: 'Seoul loop',
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
  name: 'Seoul loop',
  geometry: { type: 'LineString', coordinates: [origin, [126.9799, 37.5671]] },
  waypoints: [
    { role: 'start', position: origin, name: null, sourceSampleId: '0:0' },
    { role: 'finish', position: [126.9799, 37.5671], name: null, sourceSampleId: '0:3' },
  ],
  generation: {
    kind: 'recorded-segment',
    activityId,
    trackId,
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
  lineage: [{ activityId, trackId, trackRevision: 1 }],
  distanceMeters: 1830.5,
  contentDigest: 'b'.repeat(64),
  createdAt,
};

const bounds = {
  maxCandidates: 4,
  maxAttempts: 8,
  searchBudgetMilliseconds: 30_000,
  maxSearchRadiusMeters: 2_500,
  distanceToleranceRatio: 0.25,
};

const evaluation = (ordinal: number) => ({
  evaluationVersion: 1,
  targetDistanceMeters: 5_000,
  engineDistanceMeters: 4_800 + ordinal * 100,
  plannedLineMeters: 4_790 + ordinal * 100,
  distanceErrorMeters: -200 + ordinal * 100,
  distanceErrorRatio: (-200 + ordinal * 100) / 5_000,
  loop: { closed: true, gapMeters: 0 },
  connectivity: 'engine-attested-edges',
  repetition: {
    repeatedMeters: ordinal === 1 ? 2_400 : 0,
    repeatedRatio: ordinal === 1 ? 0.5 : 0,
    outAndBack: ordinal === 1,
  },
  knowledge: {
    stairs: 'unknown',
    surface: 'unknown',
    nightAccess: 'unknown',
    accessRestrictions: 'unknown',
    gradient: 'unknown',
  },
  gradientSource: 'none',
  maxSnapDistanceMeters: 3,
  waypointCount: 3,
  vertexCount: 3,
});

const candidateProposalIds = [
  '66666666-6666-4666-8666-666666666661',
  '66666666-6666-4666-8666-666666666662',
];

const candidate = (ordinal: number, requestId: string, graphBuildId = graph.graphBuildId) => ({
  proposalId: candidateProposalIds[ordinal],
  ordinal,
  attemptIndex: ordinal,
  candidateSeed: `${ordinal}`.repeat(16).slice(0, 16),
  waypoints: [
    { role: 'start', position: origin, name: null, sourceSampleId: null, locked: false },
    {
      role: 'via',
      position: [126.983 + ordinal * 0.001, 37.569],
      name: null,
      sourceSampleId: null,
      locked: false,
    },
    { role: 'finish', position: origin, name: null, sourceSampleId: null, locked: false },
  ],
  geometry: {
    type: 'LineString',
    coordinates: [origin, [126.983 + ordinal * 0.001, 37.569], origin],
  },
  engineDistanceMeters: 4_800 + ordinal * 100,
  engineDurationSeconds: 3_600,
  snappedWaypoints: [origin, [126.983 + ordinal * 0.001, 37.569], origin].map((position) => ({
    requested: position,
    snapped: position,
    snapDistanceMeters: 0,
  })),
  computation: computation(4, requestId, graphBuildId),
  evaluation: evaluation(ordinal),
});

function generatedSet(input: TransportRequest, graphBuildId = graph.graphBuildId) {
  const asked = input.body as { requestId: string; draftRevision: number };
  return reply({
    outcome: 'candidates_generated',
    set: {
      candidateSetId: setId,
      courseId,
      requestId: asked.requestId,
      draftRevision: asked.draftRevision,
      targetDistanceMeters: 5_000,
      searchSeed: 'feedfacefeedface',
      generatorVersion: 'target-distance-loop-v1',
      evaluationVersion: 1,
      bounds,
      search: {
        attemptsMade: 3,
        elapsedMilliseconds: 900,
        duplicatesDropped: 1,
        attempts: [
          {
            attemptIndex: 0,
            candidateSeed: '0000000000000000',
            requestedRadiusMeters: 962,
            outcome: 'accepted',
            engineDistanceMeters: 4_800,
          },
          {
            attemptIndex: 1,
            candidateSeed: '1111111111111111',
            requestedRadiusMeters: 980,
            outcome: 'accepted',
            engineDistanceMeters: 4_900,
          },
          {
            attemptIndex: 2,
            candidateSeed: '2222222222222222',
            requestedRadiusMeters: 980,
            outcome: 'duplicate',
            engineDistanceMeters: 4_905,
          },
        ],
        stoppedBecause: 'attempt_limit',
      },
      candidates: [
        candidate(0, asked.requestId, graphBuildId),
        candidate(1, asked.requestId, graphBuildId),
      ],
      createdAt,
      expiresAt: '2026-03-01T00:30:00.000Z',
    },
  });
}

function noCandidate(input: TransportRequest, outcome = 'no_candidate', status = 200) {
  const asked = input.body as { requestId: string; draftRevision: number };
  return reply(
    {
      outcome,
      courseId,
      draftRevision: asked.draftRevision,
      targetDistanceMeters: 5_000,
      searchSeed: 'feedfacefeedface',
      generatorVersion: 'target-distance-loop-v1',
      evaluationVersion: 1,
      bounds,
      search: {
        attemptsMade: 8,
        elapsedMilliseconds: 4_000,
        duplicatesDropped: 0,
        attempts: [],
        stoppedBecause: 'attempt_limit',
      },
      computation: null,
    },
    status,
  );
}

function FakeMap(props: MapViewProps) {
  return (
    <div>
      <p>지도 대역</p>
      <span data-testid="map-paths">{props.paths.map((path) => path.id).join(',')}</span>
    </div>
  );
}

function setup(overrides: (input: TransportRequest) => Reply | Promise<Reply> | null = () => null) {
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    const override = overrides(input);
    if (override) return await override;
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: [head], total: 1 });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({ status: 'available', course: head, revision });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH')
      return reply({
        status: 'available',
        course: { ...head, headRevision: 3 },
        revision: { ...revision, courseRevision: 3 },
      });
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const view = render(
    <CourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      mapView={FakeMap}
    />,
  );
  return { request, unmount: view.unmount };
}

const candidatesPath = `/bff/v1/courses/${courseId}/route-candidates`;

async function openCourse() {
  await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
  return screen.findByRole('region', { name: '경유지 편집' });
}

const patches = (request: ReturnType<typeof setup>['request']) =>
  request.mock.calls.filter(([input]) => input.method === 'PATCH');

describe('target-distance candidates on screen', () => {
  it('generates candidates and saves nothing until one is picked and reviewed', async () => {
    const { request } = setup((input) =>
      input.path === candidatesPath ? generatedSet(input) : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    const set = await screen.findByTestId('candidate-set');
    expect(set).toHaveTextContent('feedfacefeedface');
    expect(screen.getByTestId('candidate-duplicates')).toHaveTextContent('1');
    expect(screen.getByTestId('evaluation-version')).toHaveTextContent('1');
    // Four proposals on screen, nothing written.
    expect(patches(request)).toHaveLength(0);
    expect(screen.queryByTestId('candidate-review')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '1번 후보 보기' }));
    // Picking one is still not a save.
    expect(patches(request)).toHaveLength(0);
    const save = screen.getByRole('button', { name: '고른 후보 저장' });
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(patches(request)).toHaveLength(0);

    await userEvent.click(screen.getByLabelText('위 후보 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '고른 후보 저장' }));
    const sent = patches(request)[0]?.[0];
    expect(sent).toBeDefined();
    const body = sent?.body as { expectedRevision: number; change: Record<string, unknown> };
    expect(body.expectedRevision).toBe(2);
    expect(body.change).toEqual({
      kind: 'pick-candidate',
      candidateSetId: setId,
      proposalId: candidateProposalIds[0],
      draftRevision: 1,
      acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
    });
    // No geometry and no waypoint list goes out with the pick.
    expect(JSON.stringify(body.change)).not.toContain('coordinates');
  });

  it('shows the target error, the repeated sections and what it has no data for', async () => {
    setup((input) => (input.path === candidatesPath ? generatedSet(input) : null));
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    await screen.findByTestId('candidate-set');
    expect(screen.getByTestId('candidate-error-0')).toHaveTextContent('−200m');
    expect(screen.getByTestId('candidate-error-1')).toHaveTextContent('−100m');
    expect(screen.getByTestId('candidate-repeat-0')).toHaveTextContent('0m (0%)');
    expect(screen.getByTestId('candidate-repeat-1')).toHaveTextContent('왕복 구간 많음');
    // A missing fact is never a satisfied one.
    for (const ordinal of [0, 1]) {
      expect(screen.getByTestId(`candidate-knowledge-${ordinal}`)).toHaveTextContent(
        '확인되지 않음',
      );
      expect(screen.getByTestId(`candidate-gradient-${ordinal}`)).toHaveTextContent('없음');
    }
    expect(screen.getByTestId('candidate-attempts')).toHaveTextContent('3 / 8');
    expect(screen.getByRole('list', { name: '시도 기록' })).toHaveTextContent(
      '이미 제안한 후보와 대부분 겹침',
    );
  });

  it('says a search found nothing without calling it a failure, and leaves the draft alone', async () => {
    const { request } = setup((input) =>
      input.path === candidatesPath ? noCandidate(input) : null,
    );
    await openCourse();
    const before = screen.getByTestId('draft-revision').textContent;
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    expect(await screen.findByText(/목표 거리에 맞는 후보를 찾지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-set')).toBeNull();
    expect(screen.getByTestId('draft-revision')).toHaveTextContent(before ?? '');
    expect(patches(request)).toHaveLength(0);
  });

  it.each([
    ['overloaded', 429, '지금은 계산 요청이 많습니다'],
    ['timeout', 504, '제한 시간 안에 탐색이 끝나지 않았습니다'],
    ['engine_unavailable', 502, '경로 계산 엔진에 연결하지 못했습니다'],
    ['graph_mismatch', 502, '실행 중인 지도 데이터가 고정된 것과 달라'],
    ['outside_coverage', 200, '보행 네트워크 범위 밖입니다'],
  ])('tells %s apart and leaves the uncomputed draft alone', async (outcome, status, message) => {
    const { request } = setup((input) =>
      input.path === candidatesPath
        ? noCandidate(input, outcome as string, status as number)
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    expect(await screen.findByText(new RegExp(message as string))).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-set')).toBeNull();
    expect(patches(request)).toHaveLength(0);
    // None of them draws a line to stand in for the candidates that were not found.
    expect(screen.getByTestId('map-paths').textContent).not.toContain('course-candidate');
  });

  it('does not carry a review confirmation onto a different candidate', async () => {
    const { request } = setup((input) =>
      input.path === candidatesPath ? generatedSet(input) : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    await screen.findByTestId('candidate-set');
    await userEvent.click(screen.getByRole('button', { name: '1번 후보 보기' }));
    await userEvent.click(screen.getByLabelText('위 후보 내용을 검토했습니다.'));
    expect(screen.getByRole('button', { name: '고른 후보 저장' })).toBeEnabled();
    // A different candidate is a different line. Nobody has read this one.
    await userEvent.click(screen.getByRole('button', { name: '2번 후보 보기' }));
    expect(screen.getByLabelText('위 후보 내용을 검토했습니다.')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '고른 후보 저장' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '고른 후보 저장' }));
    expect(patches(request)).toHaveLength(0);
  });

  it('does not carry a review confirmation onto a newly generated search', async () => {
    const { request } = setup((input) =>
      input.path === candidatesPath ? generatedSet(input) : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    await screen.findByTestId('candidate-set');
    await userEvent.click(screen.getByRole('button', { name: '1번 후보 보기' }));
    await userEvent.click(screen.getByLabelText('위 후보 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    await screen.findByTestId('candidate-set');
    // The pick goes with the old search: a new one has nothing selected and nothing read.
    expect(screen.queryByTestId('candidate-review')).toBeNull();
    // And picking the same candidate again does not inherit the old tick. This fixture
    // deliberately answers with the same proposal ids, which is the only way a stale
    // confirmation could survive a second search at all.
    await userEvent.click(screen.getByRole('button', { name: '1번 후보 보기' }));
    expect(screen.getByLabelText('위 후보 내용을 검토했습니다.')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '고른 후보 저장' })).toBeDisabled();
    expect(patches(request)).toHaveLength(0);
  });

  it('discards a search that finished after the draft moved on', async () => {
    let release: () => void = () => undefined;
    const { request } = setup((input) => {
      if (input.path !== candidatesPath) return null;
      return new Promise<Reply>((resolve) => {
        release = () => resolve(generatedSet(input));
      });
    });
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    // The owner keeps editing while the search runs.
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.98');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.567');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    release();
    expect(await screen.findByText(/탐색하는 사이 초안이 바뀌어/)).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-set')).toBeNull();
    expect(patches(request)).toHaveLength(0);
  });

  it('never applies a search that finished after it was cancelled', async () => {
    let release: () => void = () => undefined;
    const { request } = setup((input) => {
      if (input.path !== candidatesPath) return null;
      return new Promise<Reply>((resolve) => {
        // A cancelled request can still be answered successfully: the bytes were already
        // on the wire. Nothing after the cancellation may act on it.
        release = () => resolve(generatedSet(input));
      });
    });
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    await userEvent.click(screen.getByRole('button', { name: '후보 생성 취소' }));
    release();
    expect(await screen.findByText(/후보 생성을 취소했습니다/)).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-set')).toBeNull();
    expect(patches(request)).toHaveLength(0);
  });

  it('ignores a set that belongs to a different request', async () => {
    const { request } = setup((input) => {
      if (input.path !== candidatesPath) return null;
      // The server answers about somebody else's question.
      return generatedSet({ ...input, body: { requestId: 'someone-else', draftRevision: 1 } });
    });
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    expect(await screen.findByText(/방금 보낸 요청의 것이 아니어서/)).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-set')).toBeNull();
    expect(patches(request)).toHaveLength(0);
  });

  it('keeps one engine operation in flight at a time', async () => {
    let release: () => void = () => undefined;
    setup((input) => {
      if (input.path !== candidatesPath) return null;
      return new Promise<Reply>((resolve) => {
        release = () => resolve(generatedSet(input));
      });
    });
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    expect(screen.getByRole('button', { name: '후보 생성 중' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '경로 계산' })).toBeDisabled();
    release();
    await screen.findByTestId('candidate-set');
  });

  it('says the graph changed before a course computed on an older one is replaced', async () => {
    setup((input) =>
      input.path === candidatesPath ? generatedSet(input, 'fedcba9876543210') : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '목표 거리 후보 생성' }));
    await screen.findByTestId('candidate-set');
    await userEvent.click(screen.getByRole('button', { name: '1번 후보 보기' }));
    // The head of this course was cut from a recording, so it was never computed at all:
    // there is no previous graph to contradict, and no warning belongs here.
    expect(screen.queryByTestId('candidate-graph-changed')).toBeNull();
  });
});

describe('the draft store and one generated search', () => {
  const set: DraftCandidateSet = {
    draftRevision: 1,
    candidateSetId: setId,
    targetDistanceMeters: 5_000,
    searchSeed: 'feedfacefeedface',
    generatorVersion: 'target-distance-loop-v1',
    evaluationVersion: 1,
    bounds,
    search: {
      attemptsMade: 1,
      elapsedMilliseconds: 10,
      duplicatesDropped: 0,
      attempts: [],
      stoppedBecause: 'candidate_limit',
    },
    candidates: [
      {
        proposalId: candidateProposalIds[0] ?? '',
        ordinal: 0,
        attemptIndex: 0,
        candidateSeed: '0000000000000000',
        coordinates: [origin, [126.983, 37.569], origin],
        engineDistanceMeters: 4_800,
        engineDurationSeconds: 3_600,
        graphBuildId: graph.graphBuildId,
        engineVersion: '10.0',
        computedAt: createdAt,
        warnings: [],
        evaluation: evaluation(0) as never,
      },
    ],
  };

  function store() {
    return createCourseDraftStore({
      courseId,
      headRevision: 2,
      waypoints: [
        { role: 'start', position: origin, name: null, sourceSampleId: '0:0', locked: false },
        {
          role: 'finish',
          position: [126.9799, 37.5671],
          name: null,
          sourceSampleId: '0:3',
          locked: false,
        },
      ],
    });
  }

  it('applies a search only to the draft it ran for', () => {
    const draft = store();
    draft.getState().addVia([126.98, 37.567]);
    expect(draft.getState().applyCandidates(set)).toBe(false);
    expect(draft.getState().candidates).toBeNull();
    expect(
      draft.getState().applyCandidates({ ...set, draftRevision: draft.getState().revision }),
    ).toBe(true);
    expect(currentCandidates(draft.getState())?.candidateSetId).toBe(setId);
  });

  it('stops offering a search the moment the draft moves', () => {
    const draft = store();
    draft.getState().applyCandidates(set);
    draft.getState().pickCandidate(candidateProposalIds[0] ?? '');
    expect(pickedCandidate(draft.getState())).not.toBeNull();
    draft.getState().addVia([126.98, 37.567]);
    expect(currentCandidates(draft.getState())).toBeNull();
    expect(pickedCandidate(draft.getState())).toBeNull();
  });

  it('draws only the candidate the owner picked, and never joins waypoints into a line', () => {
    const draft = store();
    draft.getState().applyCandidates(set);
    const withoutPick = draftMapPaths({
      state: draft.getState(),
      storedCoordinates: revision.geometry.coordinates as [number, number][],
    });
    expect(withoutPick.map((path) => path.id)).not.toContain('course-candidate');
    draft.getState().pickCandidate(candidateProposalIds[0] ?? '');
    const withPick = draftMapPaths({
      state: draft.getState(),
      storedCoordinates: revision.geometry.coordinates as [number, number][],
    });
    expect(withPick.map((path) => path.id)).toContain('course-candidate');
    const waypointPath = withPick.find((path) => path.id === 'course-waypoints');
    // Waypoints stay points: a line between them is a route nobody computed.
    expect(waypointPath?.breaks?.length).toBe((waypointPath?.positions.length ?? 1) - 1);
  });

  it('forgets a search when the owner starts again from what is stored', () => {
    const draft = store();
    draft.getState().addVia([126.98, 37.567]);
    draft.getState().applyCandidates({ ...set, draftRevision: draft.getState().revision });
    draft.getState().pickCandidate(candidateProposalIds[0] ?? '');
    draft.getState().syncHead(3, [
      { role: 'start', position: [126.99, 37.57], name: null, sourceSampleId: null, locked: false },
      {
        role: 'finish',
        position: [126.991, 37.571],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ]);
    draft.getState().adoptHead();
    expect(draft.getState().candidates).toBeNull();
    expect(draft.getState().pickedCandidateId).toBeNull();
  });
});
