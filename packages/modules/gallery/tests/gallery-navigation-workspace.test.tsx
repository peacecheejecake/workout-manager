import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { galleryMediaNavigationQueryV2Schema } from '@workout/contracts/gallery-navigation-v2';
import { createGalleryNavigationApi } from '../src/gallery-navigation-api';
import { GalleryWorkspace } from '../src/gallery-workspace';
import {
  createGalleryCourseChoicesApi,
  type GalleryCourseChoicesApi,
} from '../src/gallery-course-choices-api';

afterEach(cleanup);
const id = '10000000-0000-4000-8000-000000000001';
const albumId = '10000000-0000-4000-8000-000000000002';
const savedCourseLink = { courseId: albumId, courseRevision: 4, revisionId: id };
const time = '2026-10-09T00:00:00Z';
const item = {
  id,
  mediaKind: 'image',
  visibility: 'private',
  includeForCoach: false,
  album: null,
  caption: '내 사진',
  activityId: null,
  capturedAt: null,
  capturedLocalDate: null,
  file: {
    originalFileName: 'test.png',
    mediaType: 'image/png',
    byteSize: 12,
    sha256: 'a'.repeat(64),
  },
  preview: null,
  accessRevision: 1,
  createdAt: time,
  updatedAt: time,
};
const album = {
  schemaVersion: 1,
  id: albumId,
  title: '기록',
  revision: 1,
  createdAt: time,
  updatedAt: time,
};
const initialQuery = galleryMediaNavigationQueryV2Schema.parse({
  filters: {
    album: { mode: 'all' },
    mediaKind: null,
    activityId: null,
    courseLink: null,
    capturedDay: { mode: 'all' },
  },
  limit: 1,
  sort: 'created_desc_id_asc',
  cursor: null,
});
function fixture(
  write?: (method: string, body: unknown) => Promise<{ status: number; body: unknown }>,
  courseAvailability?: 'available' | 'unavailable',
) {
  const requests: {
    path: string;
    method: string;
    body: unknown;
    signal?: AbortSignal | undefined;
    idempotencyKey: string | null;
  }[] = [];
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      requests.push(input);
      let reply: { status: number; body: unknown };
      if (input.method !== 'GET')
        reply = await (write?.(input.method, input.body) ??
          Promise.resolve({ status: 500, body: null }));
      else if (input.path.startsWith('/bff/v1/gallery/media/navigation?')) {
        const query = galleryMediaNavigationQueryV2Schema.parse(
          JSON.parse(new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null'),
        );
        const rows =
          query.cursor === null
            ? [
                {
                  schemaVersion: 3,
                  item,
                  albumMembership: null,
                  courseLink: courseAvailability === undefined ? null : savedCourseLink,
                  courseAvailability:
                    courseAvailability === undefined ? null : { state: courseAvailability },
                  capturedDay: { state: 'unknown' },
                },
              ]
            : [];
        reply = {
          status: 200,
          body: {
            schemaVersion: 3,
            query,
            items: rows,
            hasMore: rows.length > 0,
            nextCursor: rows.length
              ? {
                  cursorVersion: 1,
                  binding: { filters: query.filters, limit: query.limit, sort: query.sort },
                  after: { createdAt: time, id },
                }
              : null,
          },
        };
      } else if (input.path.startsWith('/bff/v1/gallery/albums?')) {
        const query = JSON.parse(
          new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null',
        );
        reply = {
          status: 200,
          body: { schemaVersion: 1, query, items: [album], hasMore: false, nextCursor: null },
        };
      } else throw new Error('UNEXPECTED_LEGACY_REQUEST');
      return transportReplySchema.parse({ ...reply, traceId: null });
    },
  };
  return {
    requests,
    transport,
    navigation: { api: createGalleryNavigationApi(transport), initialQuery },
  };
}
function mount(f: ReturnType<typeof fixture>) {
  return render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={f.transport}
      navigation={f.navigation}
    />,
  );
}

it('uses one real adapter-backed grid and applies draft filters explicitly before following exact cursor', async () => {
  const f = fixture();
  const onNavigate = vi.fn();
  render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={f.transport}
      navigation={{ ...f.navigation, onNavigate }}
    />,
  );
  await screen.findByRole('link', { name: '내 사진' });
  expect(screen.getAllByRole('link', { name: '내 사진' })).toHaveLength(1);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('촬영일'), 'unknown');
  expect(onNavigate).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '필터 적용' }));
  await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
  expect(onNavigate.mock.calls[0]?.[0].cursor).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: '다음 페이지' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '다음 페이지' }));
  await screen.findByText('조건에 맞는 사진·동영상이 없습니다.');
  expect(onNavigate.mock.calls[1]?.[0].cursor.after.id).toBe(id);
  expect(f.requests.some((r) => r.path.startsWith('/bff/v1/gallery/media?'))).toBe(false);
});
it.each(['available', 'unavailable'] as const)(
  'renders an adapter-backed %s course fact while preserving media keyboard navigation',
  async (state) => {
    const f = fixture(undefined, state);
    mount(f);
    await screen.findByRole('link', { name: '내 사진' });
    const courseFact = state === 'unavailable' ? '리비전 4 · 사용 불가' : '리비전 4';
    expect(await screen.findByText(courseFact)).toBeVisible();
    expect(screen.queryByRole('link', { name: /코스|리비전/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/코스 삭제됨|코스 소유자/)).not.toBeInTheDocument();
    screen.getByRole('button', { name: '미디어 크게 보기' }).focus();
    await userEvent.setup().keyboard('{Enter}');
    // JSDOM does not implement the native showModal/open lifecycle; assert the
    // keyboard action mounts the viewer without claiming real modal visibility.
    expect(
      within(await screen.findByRole('dialog', { hidden: true })).getByText('내 사진'),
    ).toBeInTheDocument();
    expect(f.requests.some((request) => request.path.includes('/courses/'))).toBe(false);
    expect(f.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  },
);

it('keeps create explicit and uses the confirmed command response before clearing its draft', async () => {
  let release: ((value: { status: number; body: unknown }) => void) | undefined;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  mount(f);
  await screen.findByText('현재 앨범 페이지');
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('새 앨범 제목'), '새 앨범');
  expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: '앨범 만들기' }));
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('새 앨범');
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
  release?.({ status: 200, body: { ...album, title: '새 앨범' } });
  await waitFor(() => expect(screen.getByLabelText('새 앨범 제목')).toHaveValue(''));
  expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  expect(f.requests.find((r) => r.method === 'POST')?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
});

it('preserves frozen rename revision and draft on conflict without automatic resend', async () => {
  const f = fixture(async () => ({ status: 409, body: null }));
  mount(f);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '기록 이름 변경' }));
  await user.clear(screen.getByLabelText('변경할 앨범 제목'));
  await user.type(screen.getByLabelText('변경할 앨범 제목'), '내 변경');
  await user.click(screen.getByRole('button', { name: '앨범 이름 저장' }));
  await screen.findByText(/선택한 앨범이 변경되었습니다/);
  expect(screen.getByLabelText('변경할 앨범 제목')).toHaveValue('내 변경');
  expect(f.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
    albumId,
    expectedRevision: 1,
    title: '내 변경',
  });
  await user.click(screen.getByRole('button', { name: '변경된 앨범 다시 확인하기' }));
  expect(screen.getByRole('button', { name: '앨범 이름 저장' })).toBeDisabled();
  expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
});

it('keeps uncertain writes locked after a list read and never infers a receipt', async () => {
  const f = fixture(async () => {
    throw new Error('NETWORK_UNKNOWN');
  });
  mount(f);
  const user = userEvent.setup();
  await screen.findByText('현재 앨범 페이지');
  await user.type(screen.getByLabelText('새 앨범 제목'), '보존');
  await user.click(screen.getByRole('button', { name: '앨범 만들기' }));
  await screen.findByText(/서버 처리 결과를 아직 확인하지 못했습니다/);
  await user.click(screen.getByRole('button', { name: '처리 결과 확인' }));
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('보존');
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
  expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

it('requires delete confirmation and preserves unknown detach count without deleting media', async () => {
  const f = fixture(async () => ({
    status: 200,
    body: { schemaVersion: 1, status: 'deleted', albumId, revision: 2, detachedMediaCount: 0 },
  }));
  mount(f);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '기록 삭제 대상 선택' }));
  expect(screen.getByText('연결 해제 대상 수는 알 수 없습니다.')).toBeInTheDocument();
  expect(f.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: '이 앨범 삭제 확인' }));
  await waitFor(() => expect(f.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1));
  expect(f.requests.find((r) => r.method === 'DELETE')?.body).toEqual({
    albumId,
    expectedRevision: 1,
  });
  expect(f.requests.some((r) => r.method === 'DELETE' && r.path.includes('/media/'))).toBe(false);
});

it('resets account-scoped drafts and aborts an in-flight album command on session change', async () => {
  const f = fixture(() => new Promise(() => undefined));
  const view = mount(f);
  const user = userEvent.setup();
  await screen.findByText('현재 앨범 페이지');
  await user.type(screen.getByLabelText('새 앨범 제목'), 'private draft');
  await user.click(screen.getByRole('button', { name: '앨범 만들기' }));
  const pending = f.requests.find((r) => r.method === 'POST');
  expect(pending?.signal?.aborted).toBe(false);
  view.rerender(
    <GalleryWorkspace
      athleteId="bob"
      sessionId="two"
      transport={f.transport}
      navigation={f.navigation}
    />,
  );
  expect(pending?.signal?.aborted).toBe(true);
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('');
});

it('shows unavailable navigation and album capability while preserving the legacy grid', async () => {
  const transport: AuthenticatedTransport = {
    request: async () =>
      transportReplySchema.parse({ status: 200, body: { items: [item], total: 1 }, traceId: null }),
  };
  render(<GalleryWorkspace athleteId="alice" sessionId="one" transport={transport} />);
  await screen.findByRole('link', { name: '내 사진' });
  expect(
    screen.getByText('이 환경에서는 갤러리 탐색 연결을 사용할 수 없습니다.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '필터 적용' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
});

it('aborts navigation reads and ignores late old pages after account scope is replaced', async () => {
  let release:
    ((reply: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void) | undefined;
  let signal: AbortSignal | undefined;
  const f = fixture();
  const oldTransport: AuthenticatedTransport = {
    request: (input) => {
      if (input.path.includes('/media/navigation?')) {
        signal = input.signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return f.transport.request(input);
    },
  };
  const view = render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={oldTransport}
      navigation={{ api: createGalleryNavigationApi(oldTransport), initialQuery }}
    />,
  );
  await waitFor(() => expect(signal).toBeDefined());
  view.rerender(
    <GalleryWorkspace
      athleteId="bob"
      sessionId="two"
      transport={f.transport}
      navigation={f.navigation}
    />,
  );
  expect(signal?.aborted).toBe(true);
  await screen.findByRole('link', { name: '내 사진' });
  release?.(transportReplySchema.parse({ status: 200, body: null, traceId: null }));
  expect(screen.getAllByRole('link', { name: '내 사진' })).toHaveLength(1);
});

it('retains an uncertain command across adapter replacement and ignores an aborted late success', async () => {
  let release: ((value: { status: number; body: unknown }) => void) | undefined;
  const old = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const next = fixture();
  const nextTransport: AuthenticatedTransport = {
    request: async (input) => {
      const response = await next.transport.request(input);
      if (input.path.includes('/gallery/albums?')) {
        const query = JSON.parse(
          new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null',
        );
        return transportReplySchema.parse({
          status: 200,
          body: {
            schemaVersion: 1,
            query,
            items: [{ ...album, title: '새 연결 기록' }],
            hasMore: false,
            nextCursor: null,
          },
          traceId: null,
        });
      }
      return response;
    },
  };
  const view = mount(old);
  const user = userEvent.setup();
  await screen.findByText('현재 앨범 페이지');
  await user.type(screen.getByLabelText('새 앨범 제목'), '원 요청');
  await user.click(screen.getByRole('button', { name: '앨범 만들기' }));
  const sent = old.requests.find((request) => request.method === 'POST');
  expect(sent?.signal?.aborted).toBe(false);
  view.rerender(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={nextTransport}
      navigation={{ api: createGalleryNavigationApi(nextTransport), initialQuery }}
    />,
  );
  await screen.findByText(/서버 처리 결과를 아직 확인하지 못했습니다/);
  expect(sent?.signal?.aborted).toBe(true);
  expect(screen.queryByText('앨범 만들기 요청을 처리하는 중입니다.')).not.toBeInTheDocument();
  await screen.findByRole('heading', { name: '새 연결 기록' });
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('원 요청');
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
  // The simulated server deliberately ignores cancellation and returns its actual success later.
  release?.({ status: 200, body: { ...album, title: '원 요청' } });
  await user.click(screen.getByRole('button', { name: '처리 결과 확인' }));
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('원 요청');
  expect(screen.getByRole('heading', { name: '새 연결 기록' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
  expect(old.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(next.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  expect(sent?.idempotencyKey).toBe(
    old.requests.find((request) => request.method === 'POST')?.idempotencyKey,
  );
});

const ownedHead = {
  status: 'available',
  courseId: albumId,
  name: '현재 코스',
  visibility: 'private',
  headRevision: 4,
  revisionId: id,
  createdAt: time,
  updatedAt: time,
};
function courseReader(head = ownedHead) {
  const request = vi.fn<AuthenticatedTransport['request']>(async () =>
    transportReplySchema.parse({ status: 200, body: { courses: [head], total: 1 }, traceId: null }),
  );
  return { api: createGalleryCourseChoicesApi({ request }), request };
}
it('enables an absent course capability with one pending read and no cancellation', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    signal = input.signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return transportReplySchema.parse({
      status: 200,
      body: { courses: [ownedHead], total: 1 },
      traceId: null,
    });
  });
  const api = createGalleryCourseChoicesApi({ request });
  const props = {
    athleteId: 'alice',
    sessionId: 'one',
    transport: f.transport,
    navigation: f.navigation,
  };
  const view = render(<GalleryWorkspace {...props} />);
  await screen.findByText('이 환경에서는 코스 버전 목록 조회를 사용할 수 없습니다.');
  view.rerender(<GalleryWorkspace {...props} courseChoicesApi={api} />);
  await screen.findByText('현재 코스 버전 목록을 불러오는 중입니다.');
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(signal?.aborted).toBe(false);
  release?.();
  await screen.findByRole('option', { name: '현재 코스 · 리비전 4' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
});
it('loads exact owned current heads and applies only an explicit course filter without media writes', async () => {
  const f = fixture(undefined, 'unavailable');
  const reader = courseReader();
  const onNavigate = vi.fn();
  render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={f.transport}
      navigation={{ ...f.navigation, onNavigate }}
      courseChoicesApi={reader.api}
    />,
  );
  await screen.findByRole('option', { name: '현재 코스 · 리비전 4' });
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('연결된 코스 리비전'), `${albumId}:4:${id}`);
  expect(onNavigate).not.toHaveBeenCalled();
  expect(f.requests.every((r) => r.method === 'GET')).toBe(true);
  await user.click(screen.getByRole('button', { name: '필터 적용' }));
  await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
  expect(onNavigate.mock.calls[0]?.[0].filters.courseLink).toEqual(savedCourseLink);
  expect(onNavigate.mock.calls[0]?.[0].cursor).toBeNull();
  expect(await screen.findByText('리비전 4 · 사용 불가')).toBeVisible();
  expect(f.requests.every((r) => r.method === 'GET')).toBe(true);
});
it('preserves saved rev4 when an explicit current-head reload returns rev5', async () => {
  const f = fixture(undefined, 'unavailable');
  const reader = courseReader();
  reader.request.mockResolvedValueOnce(
    transportReplySchema.parse({
      status: 200,
      body: { courses: [ownedHead], total: 1 },
      traceId: null,
    }),
  );
  reader.request.mockResolvedValue(
    transportReplySchema.parse({
      status: 200,
      body: { courses: [{ ...ownedHead, headRevision: 5, revisionId: albumId }], total: 1 },
      traceId: null,
    }),
  );
  render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={f.transport}
      navigation={{
        ...f.navigation,
        initialQuery: {
          ...initialQuery,
          filters: { ...initialQuery.filters, courseLink: savedCourseLink },
        },
      }}
      courseChoicesApi={reader.api}
    />,
  );
  await screen.findByRole('option', { name: '현재 코스 · 리비전 4' });
  await userEvent.setup().click(screen.getByRole('button', { name: '코스 목록 다시 조회' }));
  await screen.findByRole('option', { name: '현재 코스 · 리비전 5' });
  expect(screen.getByLabelText('연결된 코스 리비전')).toHaveValue(`${albumId}:4:${id}`);
  expect(screen.getByRole('option', { name: '선택한 코스 리비전 정보 없음' })).toBeDisabled();
  expect(screen.getByText('선택한 저장 코스 버전 4')).toBeVisible();
  expect(screen.getByText('리비전 4 · 사용 불가')).toBeVisible();
  expect(f.requests.filter((r) => r.path.includes('/media/navigation?'))).toHaveLength(1);
});
it('keeps the media grid during a failed course lookup and recovers only on explicit reload', async () => {
  const f = fixture();
  const reader = courseReader();
  reader.request.mockRejectedValueOnce(new Error('private'));
  render(
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={f.transport}
      navigation={f.navigation}
      courseChoicesApi={reader.api}
    />,
  );
  await screen.findByText(/코스 버전 목록을 불러오지 못했습니다/);
  expect(screen.getByRole('link', { name: '내 사진' })).toBeVisible();
  expect(screen.getByLabelText('연결된 코스 리비전')).toBeDisabled();
  expect(reader.request).toHaveBeenCalledTimes(1);
  await userEvent.setup().click(screen.getByRole('button', { name: '코스 목록 다시 조회' }));
  await screen.findByRole('option', { name: '현재 코스 · 리비전 4' });
  expect(screen.queryByText(/코스 버전 목록을 불러오지 못했습니다/)).not.toBeInTheDocument();
});
it.each(['adapter', 'session'] as const)(
  'aborts and rejects late old course results on %s replacement',
  async (kind) => {
    const f = fixture();
    let release: (() => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const old: GalleryCourseChoicesApi = {
      list: async (signal) => {
        oldSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          choices: [{ label: '이전 계정 코스', link: savedCourseLink }],
          unavailableCount: 0,
        };
      },
    };
    const next = courseReader();
    const view = render(
      <GalleryWorkspace
        athleteId="alice"
        sessionId="one"
        transport={f.transport}
        navigation={f.navigation}
        courseChoicesApi={old}
      />,
    );
    await screen.findByText('현재 코스 버전 목록을 불러오는 중입니다.');
    await waitFor(() => expect(release).toBeDefined());
    view.rerender(
      <GalleryWorkspace
        athleteId="alice"
        sessionId={kind === 'session' ? 'two' : 'one'}
        transport={f.transport}
        navigation={f.navigation}
        courseChoicesApi={next.api}
      />,
    );
    await screen.findByRole('option', { name: '현재 코스 · 리비전 4' });
    expect(oldSignal?.aborted).toBe(true);
    release?.();
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /이전 계정 코스/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('연결된 코스 리비전')).toHaveValue('');
  },
);
