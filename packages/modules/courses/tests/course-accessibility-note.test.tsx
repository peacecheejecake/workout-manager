import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { MapViewProps } from '@workout/geo-kit/map-view';
import { CourseWorkbench } from '../src/course-workbench';

/**
 * S13 "접근성 메모" on the course card and in the detail (M2-01r), and `/courses/:id/edit`
 * opening the workbench on the course its address names.
 */
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});

const courseId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-03-01T00:00:00.000Z';
const head = (id: string, name: string, headRevision: number) => ({
  status: 'available',
  courseId: id,
  name,
  visibility: 'private',
  headRevision,
  revisionId: '55555555-5555-4555-8555-555555555555',
  createdAt,
  updatedAt: createdAt,
});
const revision = (id: string, name: string, courseRevision: number) => ({
  courseId: id,
  courseRevision,
  revisionId: '55555555-5555-4555-8555-555555555555',
  name,
  geometry: {
    type: 'LineString',
    coordinates: [
      [127.0, 37.5],
      [127.01, 37.51],
    ],
  },
  waypoints: [
    { role: 'start', position: [127.0, 37.5], name: null, sourceSampleId: null, locked: false },
    { role: 'finish', position: [127.01, 37.51], name: null, sourceSampleId: null, locked: false },
  ],
  generation: {
    kind: 'imported-file',
    format: 'gpx',
    sourceKind: 'gpx-rte',
    itemIndex: 0,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    fileSha256: 'f'.repeat(64),
    fileByteLength: 512,
    originalFilename: null,
    fileCreator: null,
    vertexCount: 2,
    importedWaypointCount: 0,
    ignoredFileWaypointCount: 0,
  },
  edit: { kind: 'imported' },
  lineage: [],
  distanceMeters: 1400,
  contentDigest: 'b'.repeat(64),
  createdAt,
});

function FakeMap() {
  return <p>지도 대역</p>;
}

function setup(
  overrides: (input: TransportRequest) => Reply | Promise<Reply> | null = () => null,
  initialCourseId?: string,
) {
  const request = vi.fn(async (input: TransportRequest): Promise<Reply> => {
    const override = overrides(input);
    if (override) return await override;
    if (input.path === '/bff/v1/courses' && input.method === 'GET')
      return reply({
        courses: [head(courseId, '한강 산책', 3), head(otherId, '남산 계단', 1)],
        total: 2,
      });
    if (input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET')
      return reply({
        status: 'available',
        course: head(courseId, '한강 산책', 3),
        revision: revision(courseId, '한강 산책', 3),
        thumbnail: { status: 'none' },
      });
    if (input.path === '/bff/v1/courses/accessibility-notes')
      return reply({
        notes: [
          { courseId, note: '계단 없음, 경사로 1곳', writtenAtRevision: 2, updatedAt: createdAt },
        ],
        total: 1,
      });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'GET')
      return reply({ preferences: [], total: 0 });
    if (input.path === '/bff/v1/courses/preferences' && input.method === 'PUT')
      return reply({ courseId, favourite: false, lastUsedAt: createdAt });
    if (input.path === '/bff/v1/courses/privacy-zones')
      return reply({ zones: [], total: 0, zoneSetDigest: 'a'.repeat(64) });
    if (input.path.endsWith('/elevation')) return reply({ outcome: 'no_dataset' });
    return reply({ error: { code: 'NOT_IN_THIS_TEST' } }, 404);
  });
  render(
    <CourseWorkbench
      athleteId="athlete-1"
      sessionId="session-1"
      transport={{ request }}
      mapView={FakeMap as unknown as ComponentType<MapViewProps>}
      {...(initialCourseId ? { initialCourseId } : {})}
    />,
  );
  return { request };
}

const noteWrites = (request: ReturnType<typeof setup>['request']) =>
  request.mock.calls.filter(([input]) => input.path.endsWith('/accessibility-note'));

describe('accessibility notes on the course card and in the detail', () => {
  it('shows each card with its note, or says it has none', async () => {
    setup();
    const list = await screen.findByRole('list', { name: '코스 목록' });
    await waitFor(() => expect(list).toHaveTextContent('접근성 메모: 계단 없음, 경사로 1곳'));
    const card = (name: string) =>
      within(list)
        .getAllByRole('listitem')
        .find((item) => within(item).queryByRole('button', { name }) !== null);
    // Written against revision 2 of a course now at revision 3: the card says so.
    expect(card('한강 산책')).toHaveTextContent('수정 번호 2에서 적음 · 이후 코스가 바뀜');
    expect(card('남산 계단')).toHaveTextContent('접근성 메모 없음');
    expect(card('남산 계단')).not.toHaveTextContent('계단 없음');
  });

  it('says it could not read the notes rather than that there are none', async () => {
    setup((input) =>
      input.path === '/bff/v1/courses/accessibility-notes'
        ? reply({ error: { code: 'INTERNAL_ERROR' } }, 500)
        : null,
    );
    const list = await screen.findByRole('list', { name: '코스 목록' });
    await waitFor(() => expect(list).toHaveTextContent('접근성 메모를 불러오지 못했습니다'));
    expect(list).not.toHaveTextContent('접근성 메모 없음');
  });

  it('writes the note against the head on screen and says it is the owner claim', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/accessibility-note`
        ? reply({
            courseId,
            note: { courseId, note: '계단 12개', writtenAtRevision: 3, updatedAt: createdAt },
          })
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: '한강 산책' }));
    const panel = await screen.findByRole('region', { name: '접근성 메모' });
    expect(panel).toHaveTextContent('이 서비스가 확인한 사실이 아닙니다');
    expect(within(panel).getByTestId('accessibility-note-earlier')).toHaveTextContent(
      '수정 번호 2에서 적었습니다',
    );
    const field = within(panel).getByLabelText('접근성 메모');
    await waitFor(() => expect(field).toHaveValue('계단 없음, 경사로 1곳'));
    await userEvent.clear(field);
    await userEvent.type(field, '계단 12개');
    await userEvent.click(within(panel).getByRole('button', { name: '메모 저장' }));
    expect(await within(panel).findByText(/수정 번호 3 기준입니다/)).toBeInTheDocument();
    expect(noteWrites(request)[0]?.[0]).toMatchObject({
      method: 'PUT',
      body: { expectedRevision: 3, note: '계단 12개' },
    });
  });

  it('refuses unsafe text on screen before sending it', async () => {
    const { request } = setup();
    await userEvent.click(await screen.findByRole('button', { name: '한강 산책' }));
    const panel = await screen.findByRole('region', { name: '접근성 메모' });
    const field = within(panel).getByLabelText('접근성 메모');
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.clear(field);
    await userEvent.type(field, '<b>계단</b>');
    await userEvent.click(within(panel).getByRole('button', { name: '메모 저장' }));
    expect(await within(panel).findByText(/꺾쇠괄호/)).toBeInTheDocument();
    expect(noteWrites(request)).toHaveLength(0);
  });

  it('clears the note with an explicit control', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/accessibility-note`
        ? reply({ courseId, note: null })
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: '한강 산책' }));
    const panel = await screen.findByRole('region', { name: '접근성 메모' });
    await userEvent.click(await within(panel).findByRole('button', { name: '메모 지우기' }));
    expect(await within(panel).findByText('접근성 메모를 지웠습니다.')).toBeInTheDocument();
    expect(noteWrites(request)[0]?.[0].body).toEqual({ expectedRevision: 3, note: null });
  });

  it('reads the course again when the note is refused as written for an old head', async () => {
    const { request } = setup((input) =>
      input.path === `/bff/v1/courses/${courseId}/accessibility-note`
        ? reply({ error: { code: 'COURSE_REVISION_CONFLICT' } }, 409)
        : null,
    );
    await userEvent.click(await screen.findByRole('button', { name: '한강 산책' }));
    const panel = await screen.findByRole('region', { name: '접근성 메모' });
    const field = within(panel).getByLabelText('접근성 메모');
    await waitFor(() => expect(field).toBeEnabled());
    const readsBefore = request.mock.calls.filter(
      ([input]) => input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET',
    ).length;
    await userEvent.type(field, ' 추가');
    await userEvent.click(within(panel).getByRole('button', { name: '메모 저장' }));
    expect(await within(panel).findByText(/그 사이 코스가 바뀌었습니다/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([input]) => input.path === `/bff/v1/courses/${courseId}` && input.method === 'GET',
        ).length,
      ).toBeGreaterThan(readsBefore),
    );
  });
});

describe('/courses/:id/edit', () => {
  it('opens the course the address names, with its name ready to edit', async () => {
    const { request } = setup(() => null, courseId);
    expect(await screen.findByRole('region', { name: '경유지 편집' })).toBeInTheDocument();
    expect(screen.getByTestId('course-revision')).toHaveTextContent('3');
    await waitFor(() => expect(screen.getByLabelText('코스 이름')).toHaveValue('한강 산책'));
    // Opening by address is a use of the course, recorded once the server has answered.
    await waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([input]) => input.path === '/bff/v1/courses/preferences' && input.method === 'PUT',
        ),
      ).toHaveLength(1),
    );
  });

  it('says a course the caller cannot read was not found, and records no use of it', async () => {
    const hidden = '99999999-9999-4999-8999-999999999999';
    const { request } = setup(
      (input) =>
        input.path === `/bff/v1/courses/${hidden}`
          ? reply({ error: { code: 'COURSE_NOT_FOUND' } }, 404)
          : null,
      hidden,
    );
    expect(await screen.findByText('코스를 찾을 수 없습니다.')).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('region', { name: '경유지 편집' })).toBeNull();
    expect(
      request.mock.calls.filter(
        ([input]) => input.path === '/bff/v1/courses/preferences' && input.method === 'PUT',
      ),
    ).toHaveLength(0);
  });
});
