import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { NewCourseWorkbench } from '../src/course-new';

/**
 * S14 `/courses/new` (M2-01r): a course started on an empty map, computed, reviewed and saved
 * — and nothing else. The screen reuses the stored-course editor's parts; these tests are
 * about what is different: there is no course to hold a proposal, so the preview stores
 * nothing and the save sends back the digest of the line the owner reviewed.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const createdId = '77777777-7777-4777-8777-777777777777';
const createdAt = '2026-03-01T00:00:00.000Z';
const digest = 'e'.repeat(64);
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

/** An answer to the preview that was actually asked, or to a named refusal of it. */
function preview(input: TransportRequest, outcome = 'route_computed') {
  const asked = input.body as {
    requestId: string;
    draftRevision: number;
    waypoints: { position: [number, number] }[];
  };
  const computation = {
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
      waypointCount: asked.waypoints.length,
    },
    computedAt: '2026-03-02T00:00:00.000Z',
    computationMilliseconds: 12,
    warnings: [],
  };
  if (outcome !== 'route_computed')
    return reply({ outcome, computation, draftRevision: asked.draftRevision });
  return reply({
    outcome: 'route_computed',
    preview: {
      requestId: asked.requestId,
      draftRevision: asked.draftRevision,
      waypoints: input.body && (input.body as { waypoints: unknown }).waypoints,
      geometry: {
        type: 'LineString',
        coordinates: [
          [127.0, 37.5],
          [127.005, 37.5052],
          [127.01, 37.51],
        ],
      },
      geometrySha256: digest,
      engineDistanceMeters: 1480.5,
      engineDurationSeconds: 1100,
      snappedWaypoints: asked.waypoints.map((waypoint) => ({
        requested: waypoint.position,
        snapped: waypoint.position,
        snapDistanceMeters: 3,
      })),
      computation,
    },
  });
}

const created = reply({
  status: 'available',
  course: {
    status: 'available',
    courseId: createdId,
    name: '한강 산책',
    visibility: 'private',
    headRevision: 1,
    revisionId: '55555555-5555-4555-8555-555555555555',
    createdAt,
    updatedAt: createdAt,
  },
  revision: {
    courseId: createdId,
    courseRevision: 1,
    revisionId: '55555555-5555-4555-8555-555555555555',
    name: '한강 산책',
    geometry: {
      type: 'LineString',
      coordinates: [
        [127.0, 37.5],
        [127.01, 37.51],
      ],
    },
    waypoints: [
      { role: 'start', position: [127.0, 37.5], name: null, sourceSampleId: null, locked: false },
      {
        role: 'finish',
        position: [127.01, 37.51],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ],
    generation: {
      kind: 'routed-waypoints',
      computation: {
        schemaVersion: 1,
        requestId: 'server-1',
        requestRevision: 3,
        graph,
        conditions: {
          profileId: 'foot-v1',
          algorithm: 'flexible',
          contractionHierarchies: false,
          maxVisitedNodes: 1_000_000,
          deadlineMilliseconds: 8_000,
          snapLimitMeters: 120,
          waypointCount: 2,
        },
        computedAt: createdAt,
        computationMilliseconds: 12,
        warnings: [],
      },
      engineDistanceMeters: 1480.5,
      engineDurationSeconds: 1100,
      maxSnapDistanceMeters: 3,
      waypointCount: 2,
      vertexCount: 2,
    },
    edit: { kind: 'created' },
    lineage: [],
    distanceMeters: 1400,
    contentDigest: 'b'.repeat(64),
    createdAt,
  },
  thumbnail: { status: 'pending', courseRevision: 1, queuedAt: createdAt },
});

function RecordingMap(seen: { paths: MapViewProps['paths'] }) {
  return function FakeMap(props: MapViewProps) {
    seen.paths = props.paths;
    return <p>지도 대역</p>;
  };
}

function setup(route: (input: TransportRequest) => Reply | Promise<Reply> | null) {
  const seen: { paths: MapViewProps['paths'] } = { paths: [] };
  const onCreated = vi.fn();
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    const answer = route(input);
    if (answer) return await answer;
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  const view = render(
    <NewCourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      mapView={RecordingMap(seen)}
      onCreated={onCreated}
    />,
  );
  return { request, onCreated, seen, unmount: view.unmount };
}

async function place(longitude: string, latitude: string) {
  await userEvent.type(screen.getByLabelText('경유점 경도'), longitude);
  await userEvent.type(screen.getByLabelText('경유점 위도'), latitude);
  await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
}

const previews = (request: ReturnType<typeof setup>['request']) =>
  request.mock.calls.filter(([input]) => input.path === '/bff/v1/courses/route-previews');
const creates = (request: ReturnType<typeof setup>['request']) =>
  request.mock.calls.filter(([input]) => input.path === '/bff/v1/courses');

describe('a course started on an empty map', () => {
  it('starts with nothing to compute and says so', () => {
    const { request } = setup(() => null);
    expect(screen.getByTestId('draft-route-status')).toHaveAttribute('data-status', 'incomplete');
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(0);
    expect(screen.getByRole('button', { name: '경로 계산' })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('places, computes, reviews and saves exactly the reviewed line', async () => {
    const { request, onCreated, seen } = setup((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === '/bff/v1/courses' && input.method === 'POST') return created;
      return null;
    });
    await place('127.0', '37.5');
    await place('127.01', '37.51');
    expect(screen.getByTestId('draft-route-status')).toHaveAttribute('data-status', 'uncomputed');
    expect(seen.paths.find((path) => path.id === 'course-uncomputed')?.role).toBe('uncomputed');

    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    const review = await screen.findByRole('group', { name: '계산된 경로 검토' });
    expect(review).toHaveTextContent('1.48km');
    expect(screen.getByTestId('draft-route-status')).toHaveAttribute('data-status', 'computed');
    expect(seen.paths.find((path) => path.id === 'course-uncomputed')).toBeUndefined();
    const asked = previews(request)[0]?.[0].body as {
      waypoints: { role: string; sourceSampleId: string | null }[];
    };
    expect(asked.waypoints.map((waypoint) => [waypoint.role, waypoint.sourceSampleId])).toEqual([
      ['start', null],
      ['finish', null],
    ]);
    // Nothing was stored by the preview, and nothing is saved before the review.
    expect(creates(request)).toHaveLength(0);
    const save = screen.getByRole('button', { name: '검토한 경로로 새 코스 저장' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByLabelText('위 내용을 검토했습니다.'));
    // A name is required, and asked for in words rather than sent and refused.
    await userEvent.click(save);
    expect(await screen.findByText(/코스 이름을 입력하세요/)).toBeInTheDocument();
    expect(creates(request)).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('새 코스 이름'), '한강 산책');
    await userEvent.click(save);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdId));
    const sent = creates(request)[0]?.[0];
    expect(sent?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.body).toEqual({
      name: '한강 산책',
      from: {
        kind: 'routed-waypoints',
        waypoints: [
          { role: 'start', position: [127, 37.5], name: null, sourceSampleId: null, locked: false },
          {
            role: 'finish',
            position: [127.01, 37.51],
            name: null,
            sourceSampleId: null,
            locked: false,
          },
        ],
        draftRevision: 3,
        reviewedGeometrySha256: digest,
        acknowledgedGraph: { previous: null, next: '0123456789abcdef' },
      },
    });
  });

  it('never applies a preview that arrives after the draft moved on', async () => {
    let answer: (() => void) | undefined;
    const { request } = setup((input) =>
      input.path === '/bff/v1/courses/route-previews'
        ? new Promise<void>((resolve) => {
            answer = resolve;
          }).then(() => preview(input))
        : null,
    );
    await place('127.0', '37.5');
    await place('127.01', '37.51');
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await waitFor(() => expect(answer).toBeDefined());
    // The owner keeps editing while the engine works.
    await place('127.02', '37.52');
    answer?.();
    expect(
      await screen.findByText(/계산하는 사이 초안이 바뀌어 이 결과를 적용하지 않았습니다/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(screen.getByTestId('draft-route-status')).toHaveAttribute('data-status', 'uncomputed');
    expect(creates(request)).toHaveLength(0);
  });

  it('says a refusal in words and leaves the uncomputed draft alone', async () => {
    const { request } = setup((input) =>
      input.path === '/bff/v1/courses/route-previews' ? preview(input, 'no_route') : null,
    );
    await place('127.0', '37.5');
    await place('127.01', '37.51');
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    expect(await screen.findByText(/보행 경로를 찾지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByTestId('draft-route-status')).toHaveAttribute('data-status', 'uncomputed');
    expect(screen.getByRole('list', { name: '경유점 목록' }).children).toHaveLength(2);
    expect(creates(request)).toHaveLength(0);
  });

  it('drops the review when the server says the line is no longer the reviewed one', async () => {
    const { request, onCreated } = setup((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === '/bff/v1/courses')
        return reply({ error: { code: 'ROUTE_PREVIEW_CHANGED' } }, 409);
      return null;
    });
    await place('127.0', '37.5');
    await place('127.01', '37.51');
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.type(screen.getByLabelText('새 코스 이름'), '한강 산책');
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로로 새 코스 저장' }));
    expect(await screen.findByText(/검토한 경로와 달랐습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '계산된 경로 검토' })).toBeNull();
    expect(creates(request)).toHaveLength(1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('retries an unknown save outcome as the same command', async () => {
    let attempt = 0;
    const { request, onCreated } = setup((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === '/bff/v1/courses') {
        attempt += 1;
        return attempt === 1 ? reply({ error: { code: 'BAD_GATEWAY' } }, 502) : created;
      }
      return null;
    });
    await place('127.0', '37.5');
    await place('127.01', '37.51');
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.type(screen.getByLabelText('새 코스 이름'), '한강 산책');
    const save = screen.getByRole('button', { name: '검토한 경로로 새 코스 저장' });
    await userEvent.click(save);
    expect(await screen.findByText(/저장 결과를 확인하지 못했습니다/)).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdId));
    const keys = creates(request).map(([input]) => input.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('does not navigate for a session that has gone', async () => {
    let answer: ((value: Reply) => void) | undefined;
    const { onCreated, unmount } = setup((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === '/bff/v1/courses')
        return new Promise<Reply>((resolve) => {
          answer = resolve;
        });
      return null;
    });
    await place('127.0', '37.5');
    await place('127.01', '37.51');
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    await userEvent.click(await screen.findByLabelText('위 내용을 검토했습니다.'));
    await userEvent.type(screen.getByLabelText('새 코스 이름'), '한강 산책');
    await userEvent.click(screen.getByRole('button', { name: '검토한 경로로 새 코스 저장' }));
    await waitFor(() => expect(answer).toBeDefined());
    unmount();
    answer?.(created);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
