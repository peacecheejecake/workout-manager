import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { NewCourseWorkbench } from '../src/course-new';
import { elevationRuns } from '../src/course-route-elevation';
import { CourseWorkbench } from '../src/course-workbench';

/**
 * S14 "고도/거리 확인" before saving (M2-01k-b).
 *
 * What these pin down, each of which a later change could quietly undo:
 *
 * - the unsaved line itself — the preview or the proposal on screen — is what is asked about;
 * - the review cannot be confirmed and nothing can be saved until the check has answered;
 * - a sample without an elevation fact is a marked gap, never a point at 0 m and never
 *   bridged by the line;
 * - no deployed dataset is said in words, with nothing drawn;
 * - the distance on the review is the engine's, not the length of the line on screen.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const createdAt = '2026-03-01T00:00:00.000Z';
const createdId = '77777777-7777-4777-8777-777777777777';
const courseId = '11111111-1111-4111-8111-111111111111';
const proposalId = '66666666-6666-4666-8666-666666666666';
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

const line: [number, number][] = [
  [127.0, 37.5],
  [127.002, 37.502],
  [127.005, 37.5052],
  [127.008, 37.508],
  [127.01, 37.51],
];

const dataset = {
  kind: 'elevation',
  datasetId: 'beef0123cafe',
  datasetVersion: 1,
  region: 'Seoul',
  sourceExtractSha256: 'a'.repeat(64),
  licence: 'ODbL-1.0',
  licenceUrl: 'https://www.openstreetmap.org/copyright',
  attribution: '© OpenStreetMap contributors',
  updateCadence: '월 1회',
  builtAt: createdAt,
  featureCount: 3,
  bbox: [126.734, 37.413, 127.269, 37.715],
};

/** Known, known, unknown, unknown, known: one gap of two samples between two known runs. */
const values: (number | null)[] = [41, 44.5, null, null, 38];

function profile(elevations: (number | null)[] = values, vertexCount = line.length) {
  return reply({
    outcome: 'profile',
    dataset,
    maxSourceDistanceMeters: 150,
    points: elevations.map((elevationMeters, vertexIndex) => ({
      vertexIndex,
      elevationMeters,
      sourceDistanceMeters: elevationMeters === null ? null : 20 + vertexIndex,
    })),
    knownCount: elevations.filter((value) => value !== null).length,
    vertexCount,
  });
}

function computation(requestId: string, draftRevision: number, waypointCount: number) {
  return {
    schemaVersion: 1,
    requestId,
    requestRevision: draftRevision,
    graph,
    conditions: {
      profileId: 'foot-v1',
      algorithm: 'flexible',
      contractionHierarchies: false,
      maxVisitedNodes: 1_000_000,
      deadlineMilliseconds: 8_000,
      snapLimitMeters: 120,
      waypointCount,
    },
    computedAt: '2026-03-02T00:00:00.000Z',
    computationMilliseconds: 12,
    warnings: [],
  };
}

/** The line on screen is about 1.42 km long; the engine says 1.48 km. They must not mix. */
const ENGINE_DISTANCE = 1480.5;

function preview(input: TransportRequest, coordinates: [number, number][] = line) {
  const asked = input.body as {
    requestId: string;
    draftRevision: number;
    waypoints: { position: [number, number] }[];
  };
  return reply({
    outcome: 'route_computed',
    preview: {
      requestId: asked.requestId,
      draftRevision: asked.draftRevision,
      waypoints: (input.body as { waypoints: unknown }).waypoints,
      geometry: { type: 'LineString', coordinates },
      geometrySha256: 'e'.repeat(64),
      engineDistanceMeters: ENGINE_DISTANCE,
      engineDurationSeconds: 1100,
      snappedWaypoints: asked.waypoints.map((waypoint) => ({
        requested: waypoint.position,
        snapped: waypoint.position,
        snapDistanceMeters: 3,
      })),
      computation: computation(asked.requestId, asked.draftRevision, asked.waypoints.length),
    },
  });
}

const routedGeneration = {
  kind: 'routed-waypoints',
  computation: computation('server-1', 3, 2),
  engineDistanceMeters: ENGINE_DISTANCE,
  engineDurationSeconds: 1100,
  maxSnapDistanceMeters: 3,
  waypointCount: 2,
  vertexCount: line.length,
};

const created = reply({
  status: 'available',
  course: {
    status: 'available',
    courseId: createdId,
    name: '고도 확인 코스',
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
    name: '고도 확인 코스',
    geometry: { type: 'LineString', coordinates: line },
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
    generation: routedGeneration,
    edit: { kind: 'created' },
    lineage: [],
    distanceMeters: 1418,
    contentDigest: 'b'.repeat(64),
    createdAt,
  },
  thumbnail: { status: 'pending', courseRevision: 1, queuedAt: createdAt },
});

function FakeMap() {
  return <p>지도 대역</p>;
}

/** A reply the test releases when it chooses to, so "before the answer" can be observed. */
function held() {
  let release: (value: Reply) => void = () => undefined;
  const promise = new Promise<Reply>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const ELEVATION = '/bff/v1/courses/elevation-profiles';

/**
 * No value on the check reads as 0 m: no drawn point, no listed sample and no axis label.
 * (The explanatory sentence "0m가 아니라 모름" is prose about gaps, not a value.)
 */
function expectNoInventedZero(check: HTMLElement) {
  for (const point of within(check).queryAllByTestId('route-elevation-point'))
    expect(point.getAttribute('data-elevation')).not.toBe('0');
  for (const sample of within(check).queryAllByTestId('route-elevation-sample'))
    expect(sample.textContent).not.toMatch(/: 0(\.0+)?m/);
  for (const label of check.querySelectorAll('svg text')) expect(label.textContent).not.toBe('0m');
}

function setupNew(route: (input: TransportRequest) => Reply | Promise<Reply> | null) {
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
      mapView={FakeMap as (props: MapViewProps) => React.JSX.Element}
      onCreated={onCreated}
    />,
  );
  return { request, onCreated, unmount: view.unmount };
}

async function place(longitude: string, latitude: string) {
  await userEvent.type(screen.getByLabelText('경유점 경도'), longitude);
  await userEvent.type(screen.getByLabelText('경유점 위도'), latitude);
  await userEvent.click(screen.getByRole('button', { name: '좌표로 경유점 추가' }));
}

async function computeNew() {
  await place('127.0', '37.5');
  await place('127.01', '37.51');
  await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
  return screen.findByRole('group', { name: '계산된 경로 검토' });
}

const calls = (request: ReturnType<typeof setupNew>['request'], path: string) =>
  request.mock.calls.filter(([input]) => input.path === path).map(([input]) => input);

describe('the elevation check of an unsaved preview', () => {
  it('asks about the previewed line and keeps the save shut until it has answered', async () => {
    const answer = held();
    const { request, onCreated } = setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) return answer.promise;
      if (input.path === '/bff/v1/courses' && input.method === 'POST') return created;
      return null;
    });
    const review = await computeNew();
    const check = within(review).getByRole('region', { name: '고도 확인' });
    // The line that was previewed, exactly — not the waypoints, not a straight line.
    await waitFor(() => expect(calls(request, ELEVATION)).toHaveLength(1));
    const asked = calls(request, ELEVATION)[0];
    expect(asked?.method).toBe('POST');
    expect(asked?.body).toEqual({ geometry: { type: 'LineString', coordinates: line } });
    expect(check).toHaveAttribute('data-outcome', 'pending');
    expect(check).toHaveTextContent('고도를 확인하는 중입니다');

    // Before the check has answered, the review cannot be confirmed and nothing is saved.
    const confirm = within(review).getByLabelText('위 내용을 검토했습니다.');
    const save = within(review).getByRole('button', { name: '검토한 경로로 새 코스 저장' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(review).getByLabelText('새 코스 이름'), '고도 확인 코스');
    await userEvent.click(confirm);
    expect(confirm).not.toBeChecked();
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(calls(request, '/bff/v1/courses')).toHaveLength(0);

    answer.release(profile());
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await userEvent.click(save);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdId));
    // In this order: preview, then the elevation check, then the save.
    const order = request.mock.calls
      .map(([input]) => input.path)
      .filter((path) =>
        ['/bff/v1/courses/route-previews', ELEVATION, '/bff/v1/courses'].includes(path),
      );
    expect(order).toEqual(['/bff/v1/courses/route-previews', ELEVATION, '/bff/v1/courses']);
  });

  it('draws known samples, marks the gap, and never puts a gap at zero', async () => {
    setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) return profile();
      return null;
    });
    const review = await computeNew();
    const check = within(review).getByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));

    expect(within(check).getByTestId('route-elevation-known')).toHaveTextContent('3 / 5');
    expect(within(check).getByTestId('route-elevation-unknown')).toHaveTextContent('2');
    expect(within(check).getByTestId('route-elevation-gaps')).toHaveTextContent('1');

    // Exactly the known values are drawn, each where its value puts it.
    const drawn = within(check).getAllByTestId('route-elevation-point');
    expect(drawn.map((point) => Number(point.getAttribute('data-elevation')))).toEqual([
      41, 44.5, 38,
    ]);
    const heights = drawn.map((point) => Number(point.getAttribute('cy')));
    // Higher is further up the chart; the lowest known value sits lowest.
    expect(heights[1]).toBeLessThan(heights[0] ?? 0);
    expect(heights[2]).toBeGreaterThan(heights[0] ?? 0);

    // One line for the run of two known neighbours; nothing drawn across the gap.
    const runs = within(check).getAllByTestId('route-elevation-run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.getAttribute('points')?.split(' ')).toHaveLength(2);

    // The gap is a marked band between the known samples around it.
    const gaps = within(check).getAllByTestId('route-elevation-gap');
    expect(gaps).toHaveLength(1);
    const gapStart = Number(gaps[0]?.getAttribute('x'));
    const gapEnd = gapStart + Number(gaps[0]?.getAttribute('width'));
    expect(gapStart).toBeCloseTo(Number(drawn[1]?.getAttribute('cx')), 5);
    expect(gapEnd).toBeCloseTo(Number(drawn[2]?.getAttribute('cx')), 5);

    // Per sample, in words: a gap is "모름", never a number, and certainly not zero.
    const samples = within(check).getAllByTestId('route-elevation-sample');
    expect(samples.map((sample) => sample.getAttribute('data-known'))).toEqual([
      'true',
      'true',
      'false',
      'false',
      'true',
    ]);
    for (const index of [2, 3]) {
      expect(samples[index]).toHaveTextContent('모름');
      expect(samples[index]?.textContent).not.toMatch(/\d+(\.\d+)?m \(가장/);
    }
    expectNoInventedZero(check);
    expect(within(check).getByRole('img')).toHaveAccessibleName(
      '고도 표본 5곳 중 값 있음 3곳, 모름 2곳(모름 구간 1개), 값 있는 표본의 최저 38m·최고 44.5m',
    );
  });

  it('draws no line at all when no sample is known, and says so', async () => {
    setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) return profile([null, null, null, null, null]);
      return null;
    });
    const review = await computeNew();
    const check = within(review).getByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));
    expect(within(check).queryAllByTestId('route-elevation-point')).toHaveLength(0);
    expect(within(check).queryAllByTestId('route-elevation-run')).toHaveLength(0);
    const gaps = within(check).getAllByTestId('route-elevation-gap');
    expect(gaps).toHaveLength(1);
    expect(check).toHaveTextContent('어디에도 고도 값이 없습니다');
    expectNoInventedZero(check);
  });

  it('says in words that no elevation data is deployed, draws nothing, and still lets the owner finish', async () => {
    const { onCreated } = setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) return reply({ outcome: 'no_dataset' });
      if (input.path === '/bff/v1/courses' && input.method === 'POST') return created;
      return null;
    });
    const review = await computeNew();
    const check = within(review).getByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'no_dataset'));
    expect(within(check).getByTestId('route-elevation-unavailable')).toHaveTextContent(
      '이 서버에는 고도 데이터가 배포되어 있지 않습니다',
    );
    expect(within(check).queryByRole('img')).toBeNull();
    expectNoInventedZero(check);
    // "Not deployed" is the answer of the check, not a reason to keep the owner out.
    await userEvent.type(within(review).getByLabelText('새 코스 이름'), '고도 확인 코스');
    await userEvent.click(within(review).getByLabelText('위 내용을 검토했습니다.'));
    await userEvent.click(
      within(review).getByRole('button', { name: '검토한 경로로 새 코스 저장' }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdId));
  });

  it('refuses a profile of some other line and asks again on request', async () => {
    let answers = 0;
    const { request } = setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) {
        answers += 1;
        return answers === 1 ? profile(values.slice(0, 3), 3) : profile();
      }
      return null;
    });
    const review = await computeNew();
    const check = within(review).getByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'failed'));
    expect(within(check).getByRole('alert')).toHaveTextContent('검토 중인 경로의 것이 아니어서');
    expect(within(check).queryAllByTestId('route-elevation-point')).toHaveLength(0);
    await userEvent.click(within(check).getByRole('button', { name: '고도 다시 확인' }));
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));
    expect(calls(request, ELEVATION)).toHaveLength(2);
  });

  it('lets a failed check through to save, and shuts the save again while a retry is out', async () => {
    // Policy (M2-01k-b §1.3): the gate is that the owner has SEEN the elevation state of this
    // line. A failed check is such a state ("모름"), so it does not block saving forever; a
    // retry is a new check, and until it answers the save is shut again.
    const retried = held();
    let asked = 0;
    const { request, onCreated } = setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) {
        asked += 1;
        return asked === 1 ? reply({ error: { code: 'ELEVATION_BROKEN' } }, 500) : retried.promise;
      }
      if (input.path === '/bff/v1/courses' && input.method === 'POST') return created;
      return null;
    });
    const review = await computeNew();
    const check = within(review).getByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'failed'));
    expect(within(check).getByRole('alert')).toHaveTextContent('고도를 확인하지 못했습니다');
    expect(within(check).queryAllByTestId('route-elevation-point')).toHaveLength(0);
    const confirm = within(review).getByLabelText('위 내용을 검토했습니다.');
    const save = within(review).getByRole('button', { name: '검토한 경로로 새 코스 저장' });
    await userEvent.type(within(review).getByLabelText('새 코스 이름'), '고도 확인 코스');
    // After the failure: the review can be confirmed and the save is allowed.
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(confirm).toBeChecked();
    expect(save).toBeEnabled();

    // A retry is pending again, and the save is shut until it answers.
    await userEvent.click(within(check).getByRole('button', { name: '고도 다시 확인' }));
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'pending'));
    expect(confirm).toBeDisabled();
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(calls(request, '/bff/v1/courses')).toHaveLength(0);

    retried.release(profile());
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdId));
    expect(calls(request, ELEVATION)).toHaveLength(2);
  });

  it('never shows a late answer for an earlier line', async () => {
    const first = held();
    let asked = 0;
    const second: [number, number][] = [
      [127.0, 37.5],
      [127.004, 37.506],
      [127.01, 37.51],
    ];
    setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews')
        return preview(input, asked === 0 ? line : second);
      if (input.path === ELEVATION) {
        asked += 1;
        return asked === 1 ? first.promise : profile([12, null, 14], 3);
      }
      return null;
    });
    const review = await computeNew();
    await waitFor(() => expect(asked).toBe(1));
    // Recompute: a new preview replaces the one whose elevation is still out.
    await userEvent.click(screen.getByRole('button', { name: '경로 계산' }));
    const check = await within(review).findByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));
    first.release(profile());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      within(check)
        .getAllByTestId('route-elevation-point')
        .map((point) => point.getAttribute('data-elevation')),
    ).toEqual(['12', '14']);
  });

  it('shows the engine distance, not the length of the line on screen', async () => {
    setupNew((input) => {
      if (input.path === '/bff/v1/courses/route-previews') return preview(input);
      if (input.path === ELEVATION) return profile();
      return null;
    });
    const review = await computeNew();
    expect(within(review).getByTestId('route-engine-distance')).toHaveTextContent('1.48km');
    // The line itself measures about 1.42 km; that number must not be what the review says.
    expect(review.textContent).not.toContain('1.42km');
  });
});

describe('the elevation check of a stored proposal', () => {
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
    generation: { ...routedGeneration, vertexCount: 2 },
    edit: { kind: 'created' },
    lineage: [],
    distanceMeters: 1418,
    contentDigest: 'b'.repeat(64),
    createdAt,
  };

  it('asks about the proposal line and keeps the reviewed save shut until it answers', async () => {
    const answer = held();
    const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
      if (input.path === '/bff/v1/courses' && input.method === 'GET')
        return reply({ courses: [head], total: 1 });
      if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
        return reply({
          status: 'available',
          course: head,
          revision,
          thumbnail: { status: 'none' },
        });
      if (input.path === `/bff/v1/courses/${courseId}/route-proposals`) {
        const asked = input.body as {
          requestId: string;
          draftRevision: number;
          waypoints: unknown[];
        };
        return reply({
          outcome: 'route_computed',
          proposal: {
            proposalId,
            courseId,
            requestId: asked.requestId,
            draftRevision: asked.draftRevision,
            waypoints: asked.waypoints,
            geometry: { type: 'LineString', coordinates: line },
            engineDistanceMeters: ENGINE_DISTANCE,
            engineDurationSeconds: 1100,
            snappedWaypoints: [
              { requested: [127.0, 37.5], snapped: [127.0, 37.5], snapDistanceMeters: 0 },
              { requested: [127.01, 37.51], snapped: [127.01, 37.51], snapDistanceMeters: 0 },
            ],
            computation: computation(asked.requestId, asked.draftRevision, 2),
            createdAt,
            expiresAt: '2026-03-01T00:30:00.000Z',
          },
        });
      }
      if (input.path === ELEVATION) return answer.promise;
      if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'PATCH')
        return reply({
          status: 'available',
          course: { ...head, headRevision: 3 },
          revision: { ...revision, courseRevision: 3 },
          thumbnail: { status: 'none' },
        });
      if (input.path.endsWith('/elevation')) return reply({ outcome: 'no_dataset' });
      if (input.path === '/bff/v1/courses/preferences') return reply({ preferences: [], total: 0 });
      if (input.path === '/bff/v1/courses/accessibility-notes')
        return reply({ notes: [], total: 0 });
      if (input.path === '/bff/v1/courses/privacy-zones')
        return reply({ zones: [], total: 0, zoneSetDigest: 'f'.repeat(64) });
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    });
    render(
      <CourseWorkbench
        athleteId="athlete-1"
        sessionId="session-1"
        transport={{ request }}
        mapView={FakeMap as (props: MapViewProps) => React.JSX.Element}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Seoul loop' }));
    const editor = await screen.findByRole('region', { name: '경유지 편집' });
    await userEvent.click(within(editor).getByRole('button', { name: '경로 계산' }));
    const review = await within(editor).findByRole('group', { name: '계산된 경로 검토' });
    await waitFor(() => expect(calls(request, ELEVATION)).toHaveLength(1));
    expect(calls(request, ELEVATION)[0]?.body).toEqual({
      geometry: { type: 'LineString', coordinates: line },
    });
    const confirm = within(review).getByLabelText('위 내용을 검토했습니다.');
    const save = within(review).getByRole('button', { name: '검토한 경로 저장' });
    expect(confirm).toBeDisabled();
    expect(save).toBeDisabled();
    answer.release(profile());
    const check = within(review).getByRole('region', { name: '고도 확인' });
    await waitFor(() => expect(check).toHaveAttribute('data-outcome', 'profile'));
    expect(within(check).getAllByTestId('route-elevation-gap')).toHaveLength(1);
    await userEvent.click(confirm);
    await userEvent.click(save);
    await waitFor(() =>
      expect(request.mock.calls.filter(([input]) => input.method === 'PATCH')).toHaveLength(1),
    );
  });
});

describe('elevation runs and gaps', () => {
  const point = (vertexIndex: number, elevationMeters: number | null) => ({
    vertexIndex,
    elevationMeters,
    sourceDistanceMeters: elevationMeters === null ? null : 1,
  });

  it('joins only neighbouring known samples and reports every gap with its neighbours', () => {
    const { runs, gaps } = elevationRuns([
      point(0, null),
      point(1, 10),
      point(2, 12),
      point(3, null),
      point(4, 0),
      point(5, null),
    ]);
    expect(runs.map((run) => run.map((sample) => [sample.index, sample.elevationMeters]))).toEqual([
      [
        [1, 10],
        [2, 12],
      ],
      [[4, 0]],
    ]);
    expect(gaps).toEqual([
      { before: null, after: 1, samples: 1 },
      { before: 2, after: 4, samples: 1 },
      { before: 4, after: null, samples: 1 },
    ]);
  });

  it('keeps a real zero as a known value, distinct from a gap', () => {
    const { runs, gaps } = elevationRuns([point(0, 0), point(1, 0)]);
    expect(runs).toHaveLength(1);
    expect(gaps).toHaveLength(0);
  });
});
