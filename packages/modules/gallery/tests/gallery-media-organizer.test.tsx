import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { galleryMediaNavigationQueryV2Schema } from '@workout/contracts/gallery-navigation-v2';
import { createGalleryNavigationApi } from '../src/gallery-navigation-api';
import { GalleryWorkspace } from '../src/gallery-workspace';
import type { GalleryCourseChoicesApi } from '../src/gallery-course-choices-api';

afterEach(cleanup);
const id = '20000000-0000-4000-8000-000000000001';
const albumId = '20000000-0000-4000-8000-000000000002';
const courseId = '20000000-0000-4000-8000-000000000003';
const revisionId = '20000000-0000-4000-8000-000000000004';
const time = '2026-10-09T00:00:00Z';
const link = { courseId, courseRevision: 2, revisionId };
function item(accessRevision: number) {
  return {
    id,
    mediaKind: 'image',
    visibility: 'private',
    includeForCoach: false,
    album: '예전 문자열',
    caption: '합성 사진',
    activityId: null,
    capturedAt: null,
    capturedLocalDate: '2026-03-01',
    file: {
      originalFileName: 'synthetic.png',
      mediaType: 'image/png',
      byteSize: 12,
      sha256: 'a'.repeat(64),
    },
    preview: null,
    accessRevision,
    createdAt: time,
    updatedAt: time,
  };
}
type Reply = { status: number; body: unknown } | 'throw';
function fixture(writes: Reply[]) {
  let revision = 1;
  let membership: { albumId: string } | null = null;
  let course: typeof link | null = null;
  const puts: { body: unknown; key: string | null }[] = [];
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      let reply: { status: number; body: unknown };
      if (input.method === 'PUT') {
        puts.push({ body: input.body, key: input.idempotencyKey });
        const next = writes.shift() ?? { status: 500, body: null };
        if (next === 'throw') throw new Error('synthetic network loss');
        reply = next;
        if (reply.status === 200) {
          revision += 1;
          const value = input.body as {
            albumMembership: typeof membership;
            courseLink: typeof course;
          };
          membership = value.albumMembership;
          course = value.courseLink;
          reply = {
            status: 200,
            body: {
              schemaVersion: 3,
              item: item(revision),
              albumMembership: membership,
              courseLink: course,
              courseAvailability: course === null ? null : { state: 'available' },
              capturedDay: { state: 'known', localDate: '2026-03-01' },
            },
          };
        }
      } else if (input.path.startsWith('/bff/v1/gallery/media/navigation?')) {
        const query = galleryMediaNavigationQueryV2Schema.parse(
          JSON.parse(new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null'),
        );
        reply = {
          status: 200,
          body: {
            schemaVersion: 3,
            query,
            items: [
              {
                schemaVersion: 3,
                item: item(revision),
                albumMembership: membership,
                courseLink: course,
                courseAvailability: course === null ? null : { state: 'available' },
                capturedDay: { state: 'known', localDate: '2026-03-01' },
              },
            ],
            hasMore: false,
            nextCursor: null,
          },
        };
      } else if (input.path.startsWith('/bff/v1/gallery/albums?')) {
        const query = JSON.parse(
          new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null',
        );
        reply = {
          status: 200,
          body: {
            schemaVersion: 1,
            query,
            items: [
              {
                schemaVersion: 1,
                id: albumId,
                title: '여행',
                revision: 1,
                createdAt: time,
                updatedAt: time,
              },
            ],
            hasMore: false,
            nextCursor: null,
          },
        };
      } else throw new Error('UNEXPECTED_REQUEST');
      return transportReplySchema.parse({ ...reply, traceId: null });
    },
  };
  const courseChoicesApi: GalleryCourseChoicesApi = {
    list: async () => ({ choices: [{ label: '강변 코스', link }], unavailableCount: 0 }),
  };
  render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={transport}
      navigation={{ api: createGalleryNavigationApi(transport) }}
      courseChoicesApi={courseChoicesApi}
    />,
  );
  return { puts };
}
const ok = { status: 200, body: null };

it('assigns an owned album and a chosen course revision with the frozen access revision', async () => {
  const user = userEvent.setup();
  const { puts } = fixture([ok]);
  await user.click(await screen.findByRole('button', { name: '앨범·코스 지정' }));
  const form = screen.getByRole('region', { name: '앨범·코스 지정' });
  expect(form).toHaveTextContent('위치 정보로 추정하지 않습니다');
  await user.selectOptions(screen.getByLabelText('지정할 앨범'), '여행');
  await waitFor(() =>
    expect(
      within(screen.getByLabelText('지정할 코스 리비전')).getByRole('option', {
        name: '강변 코스 · 리비전 2',
      }),
    ).toBeInTheDocument(),
  );
  await user.selectOptions(screen.getByLabelText('지정할 코스 리비전'), '강변 코스 · 리비전 2');
  await user.click(screen.getByRole('button', { name: '지정 저장' }));
  expect(await screen.findByText('앨범·코스 지정을 저장했습니다.')).toBeInTheDocument();
  expect(puts).toHaveLength(1);
  expect(puts[0]?.body).toEqual({
    mediaItemId: id,
    expectedAccessRevision: 1,
    albumMembership: { albumId },
    courseLink: link,
  });
  expect(puts[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  // Legacy album text is shown nowhere as membership; the owned title is.
  await waitFor(() => expect(screen.getAllByText('여행').length).toBeGreaterThan(0));
});

it('keeps the draft on a revision conflict and blocks resending it', async () => {
  const user = userEvent.setup();
  const { puts } = fixture([{ status: 409, body: { error: { code: 'MEDIA_ACCESS_CONFLICT' } } }]);
  await user.click(await screen.findByRole('button', { name: '앨범·코스 지정' }));
  await user.selectOptions(screen.getByLabelText('지정할 앨범'), '여행');
  await user.click(screen.getByRole('button', { name: '지정 저장' }));
  expect(await screen.findByText(/다른 곳에서 먼저 바뀌었습니다/)).toBeInTheDocument();
  expect(screen.getByLabelText('지정할 앨범')).toHaveValue(albumId);
  expect(screen.getByRole('button', { name: '지정 저장' })).toBeDisabled();
  expect(puts).toHaveLength(1);
});

it('confirms an uncertain result only by resending the same key and input', async () => {
  const user = userEvent.setup();
  const { puts } = fixture(['throw', ok]);
  await user.click(await screen.findByRole('button', { name: '앨범·코스 지정' }));
  await user.selectOptions(screen.getByLabelText('지정할 앨범'), '여행');
  await user.click(screen.getByRole('button', { name: '지정 저장' }));
  expect(await screen.findByText(/저장 결과를 확인하지 못했습니다/)).toBeInTheDocument();
  expect(screen.getByLabelText('지정할 앨범')).toBeDisabled();
  expect(screen.getByRole('button', { name: '취소' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '같은 요청으로 결과 확인' }));
  expect(await screen.findByText('앨범·코스 지정을 저장했습니다.')).toBeInTheDocument();
  expect(puts).toHaveLength(2);
  expect(puts[1]?.key).toBe(puts[0]?.key);
  expect(puts[1]?.body).toEqual(puts[0]?.body);
});
