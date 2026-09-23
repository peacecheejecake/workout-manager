import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { CourseWorkbench } from '../src/course-workbench';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
const activityId = '33333333-3333-4333-8333-333333333333';
const trackId = '44444444-4444-4444-8444-444444444444';
const proposalId = '66666666-6666-4666-8666-666666666666';
const otherCourseId = '88888888-8888-4888-8888-888888888888';
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

const computation = (draftRevision: number, graphBuildId = graph.graphBuildId) => ({
  schemaVersion: 1,
  requestId: 'req-1',
  requestRevision: draftRevision,
  graph: { ...graph, graphBuildId },
  conditions: {
    profileId: 'foot-v1',
    algorithm: 'flexible',
    contractionHierarchies: false,
    maxVisitedNodes: 1_000_000,
    deadlineMilliseconds: 8_000,
    snapLimitMeters: 120,
    waypointCount: 2,
  },
  computedAt: '2026-03-02T00:00:00.000Z',
  computationMilliseconds: 12,
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

function revisionWith(generation: unknown) {
  return {
    courseId,
    courseRevision: 2,
    revisionId: head.revisionId,
    name: 'Seoul loop',
    geometry: {
      type: 'LineString',
      coordinates: [
        [126.9779, 37.5665],
        [126.9799, 37.5671],
      ],
    },
    waypoints: [
      { role: 'start', position: [126.9779, 37.5665], name: null, sourceSampleId: '0:0' },
      { role: 'finish', position: [126.9799, 37.5671], name: null, sourceSampleId: '0:3' },
    ],
    generation,
    edit: { kind: 'created' },
    lineage: [{ activityId, trackId, trackRevision: 1 }],
    distanceMeters: 1830.5,
    contentDigest: 'b'.repeat(64),
    createdAt,
  };
}

const cutGeneration = {
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
};

const proposal = (
  draftRevision: number,
  graphBuildId = graph.graphBuildId,
  id = proposalId,
  requestId = 'req-1',
) => ({
  proposalId: id,
  courseId,
  requestId,
  draftRevision,
  waypoints: [
    {
      role: 'start',
      position: [126.9779, 37.5665],
      name: null,
      sourceSampleId: '0:0',
      locked: false,
    },
    {
      role: 'finish',
      position: [126.9799, 37.5671],
      name: null,
      sourceSampleId: '0:3',
      locked: false,
    },
  ],
  geometry: {
    type: 'LineString',
    coordinates: [
      [126.9779, 37.5665],
      [126.9789, 37.5669],
      [126.9799, 37.5671],
    ],
  },
  engineDistanceMeters: 1210.25,
  engineDurationSeconds: 900,
  snappedWaypoints: [
    { requested: [126.9779, 37.5665], snapped: [126.978, 37.5666], snapDistanceMeters: 12.5 },
    { requested: [126.9799, 37.5671], snapped: [126.9799, 37.5671], snapDistanceMeters: 0 },
  ],
  computation: { ...computation(draftRevision, graphBuildId), requestId },
  createdAt,
  expiresAt: '2026-03-01T00:30:00.000Z',
});

/**
 * An answer to the request that was actually asked. The screen matches the reply's course,
 * request id and draft revision against what it sent, so a fixture that invents its own
 * identifiers is answering somebody else's question.
 */
function computed(input: TransportRequest, graphBuildId = graph.graphBuildId, id = proposalId) {
  const asked = input.body as { requestId: string; draftRevision: number };
  return reply({
    outcome: 'route_computed',
    proposal: proposal(asked.draftRevision, graphBuildId, id, asked.requestId),
  });
}

/** A renderer stand-in: no WebGL, and a way to report a picked position on demand. */
function fakeMapView(onReady: (pick: (position: [number, number]) => void) => void) {
  return function FakeMap(props: MapViewProps) {
    onReady((position) => props.onPickPosition?.(position));
    return (
      <div>
        <p>지도 대역</p>
        <button
          type="button"
          onClick={() => props.onPickPosition?.([126.9789, 37.5668])}
          aria-label="지도에서 한 지점 선택"
        />
        <button
          type="button"
          onClick={() => props.onSelect({ pathId: 'course-stored', vertexIndex: 1 })}
          aria-label="지도에서 정점 선택"
        />
        <span data-testid="map-selection">
          {props.selection ? `${props.selection.pathId}:${props.selection.vertexIndex}` : '없음'}
        </span>
      </div>
    );
  };
}

function setup(
  overrides: (input: TransportRequest) => Reply | Promise<Reply> | null = () => null,
  options: { generation?: unknown } = {},
) {
  const revision = revisionWith(options.generation ?? cutGeneration);
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    const override = overrides(input);
    if (override) return await override;
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({
        courses: [head, { ...head, courseId: otherCourseId, name: 'Another loop' }],
        total: 2,
      });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({ status: 'available', course: head, revision, thumbnail: { status: 'none' } });
    if (input.path === `/bff/v1/courses/${otherCourseId}` && input.method === 'GET')
      return reply({
        status: 'available',
        course: { ...head, courseId: otherCourseId, name: 'Another loop' },
        revision: { ...revision, courseId: otherCourseId },
        thumbnail: { status: 'none' },
      });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH')
      return reply({
        status: 'available',
        course: { ...head, headRevision: 3 },
        revision: { ...revision, courseRevision: 3 },
        thumbnail: { status: 'none' },
      });
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  let pick: (position: [number, number]) => void = () => undefined;
  const view = render(
    <CourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      mapView={fakeMapView((picker) => {
        pick = picker;
      })}
    />,
  );
  return { request, unmount: view.unmount, pick: (position: [number, number]) => pick(position) };
}

async function openCourse() {
  await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
  await screen.findByRole('group', { name: '계산된 경로 검토' }).catch(() => null);
  return screen.findByRole('region', { name: '경유지 편집' });
}

describe('waypoint editor', () => {
  it('computes a route and saves nothing until the owner confirms the review', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals` ? computed(input) : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    const review = await screen.findByRole('group', { name: '계산된 경로 검토' });
    expect(review).toHaveTextContent('1.21km');
    expect(screen.getByTestId('route-graph')).toHaveTextContent('0123456789abcdef');
    // The proposal exists and the course has not changed: no write has been sent.
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);
    const save = screen.getByRole('button', { name: '검토한 경로 저장' });
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);

    await userEvent.click(screen.getByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    const patch = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'PATCH');
    expect(patch?.body).toEqual({
      expectedRevision: 2,
      change: {
        kind: 'reroute',
        proposalId,
        draftRevision: 1,
        acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
      },
    });
    // The save names a proposal. It carries no geometry, no waypoints and no distance.
    expect(JSON.stringify(patch?.body)).not.toContain('126.97');
  });

  it('discards a route computed for a draft that has moved on', async () => {
    let release: ((value: Reply) => void) | undefined;
    let asked: TransportRequest | undefined;
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? (() => {
            asked = input;
            return new Promise<Reply>((resolve) => {
              release = resolve;
            });
          })()
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    // The owner keeps editing while the engine is working.
    await userEvent.click(screen.getByRole('button', { name: '지도에서 한 지점 선택' }));
    await userEvent.click(screen.getByRole('button', { name: '선택한 위치를 경유점으로 추가' }));
    await waitFor(() => expect(release).toBeDefined());
    // A perfectly good answer to the question that was asked — the draft simply moved on.
    release?.(computed(asked as TransportRequest));
    await screen.findByText(/계산하는 사이 초안이 바뀌어 이 결과를 적용하지 않았습니다/);
    // No review panel, therefore nothing that can be saved.
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);
  });

  it.each([
    ['no_route', /보행 경로를 찾지 못했습니다/],
    ['outside_coverage', /보행 네트워크 범위 밖입니다/],
    ['snap_too_far', /너무 멀리 떨어져 있습니다/],
    ['timeout', /결과를 알 수 없으므로 저장된 것은 없습니다/],
    ['overloaded', /계산 요청이 많습니다/],
    ['engine_unavailable', /연결하지 못했습니다/],
  ] as const)('tells %s apart and leaves the uncomputed draft alone', async (outcome, message) => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? reply(
            { outcome, computation: computation(1), draftRevision: 1 },
            outcome === 'overloaded' ? 429 : outcome === 'timeout' ? 504 : 200,
          )
        : null,
    );
    await openCourse();
    const before = screen.getAllByRole('listitem').length;
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    // Nothing is drawn in place of the answer, and nothing can be saved.
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(before);
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 1');
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);
  });

  // M2-01k: the refusal an owner actually meets when iterating (F1) is not an engine
  // outcome but our own proposal bound. It must leave the edited draft exactly as it was.
  it('keeps the edited draft when the server refuses a proposal over its unsaved bound', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? reply({ error: { code: 'ROUTE_PROPOSAL_QUOTA_EXCEEDED' } }, 429)
        : null,
    );
    await openCourse();
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9795');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5675');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 2');
    const before = screen.getAllByRole('listitem').length;
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    // What the screen says today: the compute path has no message for this code (the
    // quota text exists only among the save errors), so the owner gets the generic line.
    expect(
      await screen.findByText(/경로 계산 결과를 확인하지 못했습니다\. 저장된 것은 없습니다/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(before);
    expect(screen.getByText(/37\.56750, 126\.97950/)).toBeInTheDocument();
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 2');
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);
  });

  it('cancels a computation in flight, and cancels it when the screen goes away', async () => {
    const signals: AbortSignal[] = [];
    const { unmount } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? (() => {
            const signal = input.signal;
            if (signal) signals.push(signal);
            // A real transport rejects when its signal fires; the fake has to as well, or
            // the screen would never learn that the computation it started is over.
            return new Promise<Reply>((_resolve, rejectRequest) => {
              signal?.addEventListener('abort', () =>
                rejectRequest(new DOMException('aborted', 'AbortError')),
              );
            });
          })()
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(signals).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: '계산 취소' }));
    expect(signals[0]?.aborted).toBe(true);
    await screen.findByText(/경로 계산을 취소했습니다/);

    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(signals).toHaveLength(2));
    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('is completely usable without a map and without a drag', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals` ? computed(input) : null,
    );
    await openCourse();
    // A waypoint placed by typing its coordinates, with no pointer on any map.
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
    // Reordered with buttons.
    await userEvent.click(screen.getByRole('button', { name: '2번 앞으로' }));
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 3');
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(true);
  });

  it('says the graph changed before a course computed on an older one is replaced', async () => {
    const routedHead = {
      kind: 'routed-waypoints',
      computation: computation(1, 'aaaaaaaaaaaaaaaa'),
      engineDistanceMeters: 1000,
      engineDurationSeconds: 800,
      maxSnapDistanceMeters: 2,
      waypointCount: 2,
      vertexCount: 3,
    };
    const { request } = setup(
      (input) =>
        input.path === `/bff/v1/courses/${courseId}/route-proposals`
          ? computed(input, '0123456789abcdef')
          : null,
      { generation: routedHead },
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    const notice = await screen.findByTestId('graph-changed');
    expect(notice).toHaveTextContent('aaaaaaaaaaaaaaaa');
    expect(notice).toHaveTextContent('0123456789abcdef');
    await userEvent.click(screen.getByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    const patch = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'PATCH');
    expect(
      (patch?.body as { change: { acknowledgedGraph: unknown } }).change.acknowledgedGraph,
    ).toEqual({
      previous: 'aaaaaaaaaaaaaaaa',
      next: '0123456789abcdef',
    });
  });

  it('keeps the save command when the outcome is unknown, and starts a new one after a refusal', async () => {
    let patchStatus = 503;
    const { request } = setup((input) => {
      if (input.path === `/bff/v1/courses/${courseId}/route-proposals`) return computed(input);
      if (input.method === 'PATCH' && patchStatus !== 200)
        return reply(
          {
            error: {
              code: patchStatus === 409 ? 'COURSE_REVISION_CONFLICT' : 'UPSTREAM_UNAVAILABLE',
            },
          },
          patchStatus,
        );
      return null;
    });
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/저장 결과를 확인하지 못했습니다/);
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/저장 결과를 확인하지 못했습니다/);
    const keys = request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.method === 'PATCH')
      .map((input) => input.idempotencyKey);
    expect(keys).toHaveLength(2);
    // A 503 does not say whether the revision was written, so the retry is the same
    // command under the same key rather than a second one.
    expect(keys[0]).toBe(keys[1]);

    // Our own refusal proves nothing was stored: the next attempt is a new command.
    patchStatus = 409;
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/이 코스가 다른 곳에서 먼저 바뀌었습니다/);
    patchStatus = 200;
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    const afterRefusal = request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.method === 'PATCH')
      .map((input) => input.idempotencyKey);
    expect(afterRefusal).toHaveLength(4);
    expect(afterRefusal[3]).not.toBe(afterRefusal[0]);
  });

  it('says so when this server has no routing engine configured', async () => {
    setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? reply({ error: { code: 'NOT_FOUND' } }, 404)
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    expect(await screen.findByText(/경로 계산 기능이 구성되어 있지 않습니다/)).toBeInTheDocument();
  });
});

/**
 * Three defects an independent review reproduced. Each test here is the reproduction, kept
 * so the guard that fixes it cannot quietly go away again.
 */
describe('review, cancellation and draft identity', () => {
  it('does not carry a review confirmation onto a newly computed route', async () => {
    let attempt = 0;
    const { request } = setup((input) => {
      if (input.path !== `/bff/v1/courses/${courseId}/route-proposals`) return null;
      attempt += 1;
      const asked = input.body as { requestId: string; draftRevision: number };
      return reply({
        outcome: 'route_computed',
        proposal:
          attempt === 1
            ? proposal(asked.draftRevision, '0123456789abcdef', proposalId, asked.requestId)
            : proposal(
                asked.draftRevision,
                'fedcba9876543210',
                '77777777-7777-4777-8777-777777777777',
                asked.requestId,
              ),
      });
    });
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    expect(screen.getByRole('button', { name: '검토한 경로 저장' })).toBeEnabled();

    // Recomputed without touching a waypoint: the draft revision is unchanged, so a review
    // keyed only to it would still look confirmed — for a route the owner has not read.
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() =>
      expect(screen.getByTestId('route-graph')).toHaveTextContent('fedcba9876543210'),
    );
    expect(screen.getByRole('button', { name: '검토한 경로 저장' })).toBeDisabled();
    expect(screen.getByLabelText('위 내용을 검토했습니다.')).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);

    // Confirmed again, the save names the proposal that was actually reviewed.
    await userEvent.click(screen.getByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    const patch = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      change: {
        proposalId: '77777777-7777-4777-8777-777777777777',
        acknowledgedGraph: { previous: null, next: 'fedcba9876543210' },
      },
    });
  });

  it('never applies a computation that finished after it was cancelled', async () => {
    // The previous cancellation test made the transport reject, which is the easy half. A
    // real transport can also answer successfully after the signal fired — the bytes were
    // already on the wire — and that answer belongs to a request the owner abandoned.
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? (() => {
            const asked = input.body as { requestId: string; draftRevision: number };
            return new Promise<Reply>((resolve) => {
              input.signal?.addEventListener('abort', () =>
                resolve(
                  reply({
                    outcome: 'route_computed',
                    proposal: proposal(
                      asked.draftRevision,
                      '0123456789abcdef',
                      proposalId,
                      asked.requestId,
                    ),
                  }),
                ),
              );
            });
          })()
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByRole('button', { name: '계산 취소' }));
    await screen.findByText(/경로 계산을 취소했습니다/);
    // Nothing to review, therefore nothing that can be saved.
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);
  });

  it('ignores an answer that belongs to a different request', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? reply({
            outcome: 'route_computed',
            // A well-formed answer, but to somebody else's question.
            proposal: proposal(1, '0123456789abcdef', proposalId, 'a-different-request'),
          })
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await screen.findByText(/이 계산 결과가 방금 보낸 요청의 것이 아니어서/);
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(0);
  });
});

/**
 * A draft is the owner's unsaved work. It must not disappear because something else about
 * the course changed — least of all because of an edit made on this very screen.
 */
const savedWaypoints = [
  { role: 'start', position: [126.9779, 37.5665], name: null, sourceSampleId: '0:0' },
  { role: 'via', position: [126.9789, 37.5668], name: null, sourceSampleId: null },
  { role: 'finish', position: [126.9799, 37.5671], name: null, sourceSampleId: '0:3' },
] as ReturnType<typeof revisionWith>['waypoints'];

function renderWithMovingHead(options: { holdWrites?: boolean } = {}) {
  const held: (() => void)[] = [];
  const stored = {
    headRevision: 2,
    name: 'Seoul loop',
    waypoints: revisionWith(cutGeneration).waypoints,
    /** Simulates a resend answered with the course as it is now, after a later edit. */
    extraRevisionOnReroute: 0,
    /** Simulates the server refusing a write whose expected revision is stale. */
    refuseWrites: false,
  };
  const applyWrite = (body: { change: { kind: string; name?: string } }): Reply => {
    stored.headRevision += 1;
    if (body.change.kind === 'rename' && body.change.name) stored.name = body.change.name;
    // A saved reroute is what the server does with a reviewed proposal: the stored
    // waypoints become the ones that were computed from.
    if (body.change.kind === 'reroute') {
      stored.waypoints = savedWaypoints;
      stored.headRevision += stored.extraRevisionOnReroute;
    }
    return reply({
      status: 'available',
      course: { ...head, headRevision: stored.headRevision, name: stored.name },
      revision: {
        ...revisionWith(cutGeneration),
        courseRevision: stored.headRevision,
        name: stored.name,
        waypoints: stored.waypoints,
      },
      thumbnail: { status: 'none' },
    });
  };
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    const revision = {
      ...revisionWith(cutGeneration),
      courseRevision: stored.headRevision,
      name: stored.name,
      waypoints: stored.waypoints,
    };
    const headNow = { ...head, headRevision: stored.headRevision, name: stored.name };
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({ courses: [headNow], total: 1 });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({
        status: 'available',
        course: headNow,
        revision,
        thumbnail: { status: 'none' },
      });
    if (input.path === `/bff/v1/courses/${courseId}/route-proposals`) return computed(input);
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH') {
      if (stored.refuseWrites) return reply({ error: { code: 'COURSE_REVISION_CONFLICT' } }, 409);
      const body = input.body as { change: { kind: string; name?: string } };
      if (options.holdWrites)
        return new Promise<Reply>((resolve) => {
          held.push(() => resolve(applyWrite(body)));
        });
      return applyWrite(body);
    }
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const view = render(
    <CourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      mapView={fakeMapView(() => undefined)}
    />,
  );
  return {
    request,
    stored,
    unmount: view.unmount,
    releaseWrite: () => {
      const next = held.shift();
      if (!next) throw new Error('no write is being held');
      next();
    },
  };
}

describe('an unsaved draft across a changing head', () => {
  it('keeps unsaved waypoint edits when only the course name is saved', async () => {
    renderWithMovingHead();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 2');

    // A rename on this same screen. It advances the stored head, but it changes nothing
    // about the waypoints the owner is editing.
    await userEvent.clear(screen.getByLabelText('코스 이름'));
    await userEvent.type(screen.getByLabelText('코스 이름'), '새 이름');
    await userEvent.click(screen.getByRole('button', { name: '이름 저장' }));
    await screen.findByText(/이름을 저장했습니다/);
    await waitFor(() => expect(screen.getByTestId('course-revision')).toHaveTextContent('3'));

    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 2');
    expect(screen.queryByTestId('draft-conflict')).toBeNull();
  });

  it('asks before discarding a draft when the stored waypoints changed elsewhere', async () => {
    const { stored } = renderWithMovingHead();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);

    // Somewhere else, the course was re-cut: different stored waypoints, newer head.
    stored.headRevision = 5;
    stored.waypoints = [
      { role: 'start', position: [127.001, 37.6], name: null, sourceSampleId: '0:0' },
      { role: 'via', position: [127.002, 37.601], name: null, sourceSampleId: null },
      { role: 'via', position: [127.003, 37.602], name: null, sourceSampleId: null },
      { role: 'finish', position: [127.004, 37.603], name: null, sourceSampleId: '0:9' },
    ] as typeof stored.waypoints;
    await userEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await userEvent.click(screen.getByRole('button', { name: '다시 실행' }));
    // Trigger a refetch the way the screen does after any write.
    await userEvent.clear(screen.getByLabelText('코스 이름'));
    await userEvent.type(screen.getByLabelText('코스 이름'), '다른 이름');
    await userEvent.click(screen.getByRole('button', { name: '이름 저장' }));

    const conflict = await screen.findByTestId('draft-conflict');
    expect(conflict).toHaveTextContent('저장된 코스가 다른 곳에서 바뀌었습니다');
    // The draft is still the owner's until they say otherwise.
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: '저장된 내용으로 다시 시작' }));
    await waitFor(() =>
      expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(4),
    );
    expect(screen.queryByTestId('draft-conflict')).toBeNull();
  });

  it('reads the course again when a write is refused, which is how a change reaches the draft', async () => {
    const { stored } = renderWithMovingHead();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);

    // The course moved somewhere else, so this screen's next write is stale and refused.
    // Nothing else on this screen refetches, so if a refusal did not, the draft would never
    // learn about the change and the conflict notice would be unreachable.
    stored.headRevision = 7;
    stored.waypoints = savedWaypoints;
    stored.refuseWrites = true;
    await userEvent.clear(screen.getByLabelText('코스 이름'));
    await userEvent.type(screen.getByLabelText('코스 이름'), '바꿔 보려 한다');
    await userEvent.click(screen.getByRole('button', { name: '이름 저장' }));
    await screen.findByText(/다른 변경이 먼저 저장되었습니다/);
    const conflict = await screen.findByTestId('draft-conflict');
    expect(conflict).toHaveTextContent('저장된 코스가 다른 곳에서 바뀌었습니다');
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
  });

  it('does not adopt a head that this save did not produce', async () => {
    const { stored } = renderWithMovingHead();
    // A resend is answered with the course as it is now, which may already carry a later
    // edit by somebody else. That head is not this command's result.
    stored.extraRevisionOnReroute = 1;
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    const conflict = await screen.findByTestId('draft-conflict');
    expect(conflict).toHaveTextContent('저장된 코스가 다른 곳에서 바뀌었습니다');
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
  });

  it('continues from what its own route save wrote, without asking', async () => {
    const { request, stored } = renderWithMovingHead();
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await screen.findByText(/경로를 저장했습니다/);
    await waitFor(() => expect(screen.getByTestId('course-revision')).toHaveTextContent('3'));
    // The owner's own save moved the stored waypoints. That is not somebody else's change,
    // so there is nothing to confirm and the draft continues from what was written.
    expect(screen.queryByTestId('draft-conflict')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3),
    );
    expect(stored.headRevision).toBe(3);
    expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(true);
  });
});

/**
 * Two races an independent review reproduced: the same ownership question as before, asked
 * one layer further out. Owning the geometry application is not enough if the cleanup and
 * the acknowledgement do not ask the same question.
 */
describe('ownership of state a late response touches', () => {
  it('does not let a cancelled computation end a newer one', async () => {
    const pending: {
      signal?: AbortSignal;
      resolve: (value: Reply) => void;
      input: TransportRequest;
    }[] = [];
    setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? new Promise<Reply>((resolve) => {
            pending.push({ ...(input.signal ? { signal: input.signal } : {}), resolve, input });
          })
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: '계산 취소' }));
    await screen.findByText(/경로 계산을 취소했습니다/);

    // A second computation is started. The first one is still out there.
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getByRole('button', { name: '계산 취소' })).toBeInTheDocument();

    // The abandoned request finally answers. It owns nothing on this screen any more: it
    // must not take the second computation's "in flight" state away with it.
    const first = pending[0];
    if (!first) throw new Error('missing request');
    first.resolve(computed(first.input));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getByRole('button', { name: '계산 취소' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '경로 계산 중' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
  });

  it('does not let an abandoned request speak over a newer one', async () => {
    const pending: { reject: (error: unknown) => void; signal?: AbortSignal }[] = [];
    setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/route-proposals`
        ? new Promise<Reply>((_resolve, reject) => {
            pending.push({ reject, ...(input.signal ? { signal: input.signal } : {}) });
          })
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: '계산 취소' }));
    await screen.findByText(/경로 계산을 취소했습니다/);

    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.queryByText(/경로 계산을 취소했습니다/)).toBeNull();

    // The abandoned request now rejects, as an aborted transport does. Its cancellation
    // was already reported when the owner cancelled it; saying it again now would be about
    // the computation that is still running.
    pending[0]?.reject(new DOMException('aborted', 'AbortError'));
    await waitFor(() => expect(screen.getByRole('button', { name: '계산 취소' })).toBeVisible());
    expect(screen.queryByText(/경로 계산을 취소했습니다/)).toBeNull();
    expect(screen.queryByText(/결과를 확인하지 못했습니다/)).toBeNull();
  });

  it('does not destroy an edit made while its own save was in flight', async () => {
    const { stored, releaseWrite } = renderWithMovingHead({ holdWrites: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));

    // While the save is out there, the owner keeps editing.
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9799');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5679');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(4);

    // The save succeeds normally. It is this draft's own save — but not of this draft.
    releaseWrite();
    await screen.findByText(/경로를 저장했습니다/);
    await waitFor(() => expect(stored.headRevision).toBe(3));
    const conflict = await screen.findByTestId('draft-conflict');
    expect(conflict).toHaveTextContent('저장한 뒤에도 경유점을 더 고쳤습니다');
    // The later edit is still there until the owner says what to do with it.
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: '저장된 내용으로 다시 시작' }));
    await waitFor(() =>
      expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3),
    );
  });

  it('leaves nothing of one course behind when another is opened', async () => {
    const pending: { resolve: (value: Reply) => void; signal?: AbortSignal }[] = [];
    setup((input) =>
      input.path.endsWith('/route-proposals')
        ? new Promise<Reply>((resolve) => {
            pending.push({ resolve, ...(input.signal ? { signal: input.signal } : {}) });
          })
        : null,
    );
    await openCourse();
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    // Opening a different course replaces the editor. The computation the first one
    // started must not outlive it, and nothing it was saying may carry over.
    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await waitFor(() => expect(pending[0]?.signal?.aborted ?? false).toBe(true));
    await screen.findByRole('region', { name: '경유지 편집' });
    expect(screen.queryByRole('button', { name: '계산 취소' })).toBeNull();
    expect(screen.getByRole('button', { name: '경로 계산' })).toBeEnabled();
  });
});

/**
 * The fourth instance of the same shape: an action that outlives what it belongs to. Here
 * it is the whole editor. Switching to an **already cached** course produced no loading
 * gap, so the editor was never unmounted and the previous course's computation went on
 * living inside it — with its cancel button and its blocked compute control.
 */
describe('an editor that belongs to one course', () => {
  it('tears down a computation when switching to a course that is already cached', async () => {
    const pending: { resolve: (value: Reply) => void; signal?: AbortSignal }[] = [];
    setup((input) =>
      input.path.endsWith('/route-proposals')
        ? new Promise<Reply>((resolve) => {
            pending.push({ resolve, ...(input.signal ? { signal: input.signal } : {}) });
          })
        : null,
    );
    // Open the other course first so its read is cached: coming back to it later then has
    // no pending state, which is exactly the case that kept the old editor alive.
    await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByRole('button', { name: '계산 취소' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    // The computation belonged to the course that is no longer open.
    await waitFor(() => expect(pending[0]?.signal?.aborted ?? false).toBe(true));
    expect(screen.queryByRole('button', { name: '계산 취소' })).toBeNull();
    expect(screen.getByRole('button', { name: '경로 계산' })).toBeEnabled();
    expect(screen.queryByText(/경로를 계산했습니다/)).toBeNull();
  });

  it('does not carry a map selection onto another course', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: '지도에서 정점 선택' }));
    expect(screen.getByTestId('map-selection')).toHaveTextContent('course-stored:1');
    // A selected vertex is a position in one course's geometry. The same index in another
    // course is a different place, so the selection belongs to the course, not the screen.
    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    expect(screen.getByTestId('map-selection')).toHaveTextContent('없음');
  });

  it('carries no save in flight across a course change', async () => {
    let releaseSave: ((value: Reply) => void) | undefined;
    const { request } = setup((input) => {
      if (input.path.endsWith('/route-proposals')) return computed(input);
      if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH')
        return new Promise<Reply>((resolve) => {
          releaseSave = resolve;
        });
      return null;
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로 저장' }));
    await waitFor(() => expect(releaseSave).toBeDefined());

    // Back to the cached course, and an edit of its own.
    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.type(screen.getByLabelText('경유점 경도'), '126.9789');
    await userEvent.type(screen.getByLabelText('경유점 위도'), '37.5668');
    await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);

    // The other course's save lands. It is not about this course and must not touch it.
    releaseSave?.(
      reply({
        status: 'available',
        course: { ...head, headRevision: 3 },
        revision: { ...revisionWith(cutGeneration), courseRevision: 3 },
        thumbnail: { status: 'none' },
      }),
    );
    await waitFor(() =>
      expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(1),
    );
    expect(screen.queryByTestId('draft-conflict')).toBeNull();
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(3);
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('초안 변경 번호 2');
    // No leftover of the other course's save: this screen is not "saving" anything.
    expect(screen.queryByText(/경로를 저장했습니다/)).toBeNull();
  });
});

/**
 * The same question asked of the screen around the editor: a write started on one course
 * must not report itself, or act, on whichever course happens to be open when it lands.
 */
describe('writes that belong to the course they were started on', () => {
  it('does not report one course rename on another course', async () => {
    let releaseRename: ((value: Reply) => void) | undefined;
    setup((input) =>
      input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH'
        ? new Promise<Reply>((resolve) => {
            releaseRename = resolve;
          })
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await screen.findByLabelText('코스 이름');
    await userEvent.clear(screen.getByLabelText('코스 이름'));
    await userEvent.type(screen.getByLabelText('코스 이름'), '새 이름');
    await userEvent.click(screen.getByRole('button', { name: '이름 저장' }));
    await waitFor(() => expect(releaseRename).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    releaseRename?.(
      reply({
        status: 'available',
        course: { ...head, headRevision: 3 },
        revision: { ...revisionWith(cutGeneration), courseRevision: 3 },
        thumbnail: { status: 'none' },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Another loop' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(screen.queryByText(/이름을 저장했습니다/)).toBeNull();
  });

  it('does not deselect the course now open when another one is deleted', async () => {
    let releaseDelete: ((value: Reply) => void) | undefined;
    setup((input) =>
      input.method === 'DELETE'
        ? new Promise<Reply>((resolve) => {
            releaseDelete = resolve;
          })
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('button', { name: '코스 삭제' });
    await userEvent.click(screen.getByRole('button', { name: '코스 삭제' }));
    await waitFor(() => expect(releaseDelete).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    releaseDelete?.(reply({ deleted: true }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Another loop' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    // The course that is open stays open; deleting a different one does not close it.
    expect(screen.getByRole('region', { name: '경유지 편집' })).toBeInTheDocument();
  });
});

/**
 * The failure paths of the same writes. A request that fails after the owner has moved on
 * must not report itself on the course they are looking at now — display only, but the
 * same shape as everything else here.
 */
describe('failures that belong to the course they were started on', () => {
  it('does not show one course delete failure on another course', async () => {
    let failDelete: ((value: Reply) => void) | undefined;
    setup((input) =>
      input.method === 'DELETE'
        ? new Promise<Reply>((resolve) => {
            failDelete = resolve;
          })
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
    await screen.findByRole('button', { name: '코스 삭제' });
    await userEvent.click(screen.getByRole('button', { name: '코스 삭제' }));
    await waitFor(() => expect(failDelete).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
    await screen.findByRole('region', { name: '경유지 편집' });
    failDelete?.(reply({ error: { code: 'COURSE_REVISION_CONFLICT' } }, 409));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Another loop' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(screen.queryByText(/다른 변경이 먼저 저장되었습니다/)).toBeNull();
  });

  it('does not show one course export failure on another course', async () => {
    let failExport: ((value: Response) => void) | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          failExport = resolve;
        }),
    ) as unknown as typeof globalThis.fetch;
    try {
      setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Another loop' }));
      await screen.findByRole('region', { name: '경유지 편집' });
      await userEvent.click(screen.getByRole('button', { name: 'Seoul loop' }));
      await userEvent.click(await screen.findByTestId('course-export'));
      await waitFor(() => expect(failExport).toBeDefined());

      await userEvent.click(screen.getByRole('button', { name: 'Another loop' }));
      await screen.findByRole('region', { name: '경유지 편집' });
      failExport?.({ ok: false, status: 503 } as Response);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Another loop' }).getAttribute('aria-pressed'),
        ).toBe('true'),
      );
      expect(screen.queryByText(/입력을 확인한 뒤 다시 시도하세요/)).toBeNull();
      expect(screen.queryByText(/요청을 완료하지 못했습니다/)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
