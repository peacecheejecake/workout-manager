import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  galleryAlbumV1Schema,
  galleryMediaNavigationQueryV2Schema,
} from '@workout/contracts/gallery-navigation-v2';
import { galleryMediaNavigationPageV3Schema } from '@workout/contracts/gallery-navigation-v3';
import {
  GalleryNavigation,
  GalleryNavigationControls,
  GalleryNavigationResultFrame,
  type GalleryNavigationFilters,
  type GalleryNavigationProps,
} from '../src/gallery-navigation';

afterEach(cleanup);
const mediaId = '10000000-0000-4000-8000-000000000001';
const albumId = '10000000-0000-4000-8000-000000000002';
const link = {
  courseId: '10000000-0000-4000-8000-000000000003',
  courseRevision: 4,
  revisionId: '10000000-0000-4000-8000-000000000004',
};
const query = galleryMediaNavigationQueryV2Schema.parse({
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
const album = galleryAlbumV1Schema.parse({
  schemaVersion: 1,
  id: albumId,
  title: '대회',
  revision: 1,
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
});
function page(hasMore = false, known = false) {
  const createdAt = '2026-10-09T00:00:00Z';
  return galleryMediaNavigationPageV3Schema.parse({
    schemaVersion: 3,
    query,
    items: [
      {
        schemaVersion: 3,
        item: {
          id: mediaId,
          mediaKind: 'image',
          visibility: 'private',
          includeForCoach: false,
          album: null,
          caption: '결승선',
          activityId: null,
          capturedAt: known ? '2026-10-09T03:00:00Z' : null,
          capturedLocalDate: known ? '2026-10-08' : null,
          file: {
            originalFileName: 'finish.png',
            mediaType: 'image/png',
            byteSize: 2048,
            sha256: 'a'.repeat(64),
          },
          preview: null,
          accessRevision: 1,
          createdAt,
          updatedAt: createdAt,
        },
        albumMembership: null,
        courseLink: null,
        courseAvailability: null,
        capturedDay: known ? { state: 'known', localDate: '2026-10-08' } : { state: 'unknown' },
      },
    ],
    hasMore,
    nextCursor: hasMore
      ? {
          cursorVersion: 1,
          binding: { filters: query.filters, limit: query.limit, sort: query.sort },
          after: { createdAt, id: mediaId },
        }
      : null,
  });
}
function setup(overrides: Partial<GalleryNavigationProps> = {}) {
  const navigate = vi.fn();
  const reload = vi.fn();
  const openMedia = vi.fn();
  const changeFilters = vi.fn();
  function Controlled() {
    const [filters, setFilters] = useState<GalleryNavigationFilters>(
      overrides.filters ?? query.filters,
    );
    return (
      <GalleryNavigation
        limit={query.limit}
        albums={[album]}
        courses={[{ label: '강변', link }]}
        result={{ state: 'ready', page: page() }}
        actions={{
          navigate,
          reload,
          openMedia,
          changeFilters: (value) => {
            changeFilters(value);
            setFilters(value);
          },
        }}
        {...overrides}
        filters={filters}
      />
    );
  }
  const view = render(<Controlled />);
  return { ...view, navigate, reload, openMedia, changeFilters, user: userEvent.setup() };
}

it('applies controlled album and exact course revision only on explicit submit with a fresh cursor', async () => {
  const { user, navigate } = setup();
  await user.selectOptions(screen.getByLabelText('앨범'), albumId);
  await user.selectOptions(
    screen.getByLabelText('연결된 코스 리비전'),
    `${link.courseId}:${link.courseRevision}:${link.revisionId}`,
  );
  expect(navigate).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '필터 적용' }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    ...query,
    filters: { ...query.filters, album: { mode: 'album', albumId }, courseLink: link },
  });
});
it.each(['available', 'unavailable'] as const)(
  'shows the %s saved course fact without inventing a course destination or label',
  async (state) => {
    const base = page();
    const linked = galleryMediaNavigationPageV3Schema.parse({
      ...base,
      items: base.items.map((row) => ({ ...row, courseLink: link, courseAvailability: { state } })),
    });
    const { user, openMedia, navigate } = setup({
      courses: [],
      result: { state: 'ready', page: linked },
    });
    const card = screen.getByRole('listitem');
    expect(within(card).getByText('저장된 코스 리비전 4')).toBeVisible();
    expect(within(card).queryByText('사용 불가') !== null).toBe(state === 'unavailable');
    expect(within(card).queryByText(/강변|삭제|소유자/)).not.toBeInTheDocument();
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    screen.getByRole('button', { name: '결승선' }).focus();
    await user.keyboard('{Enter}');
    expect(openMedia).toHaveBeenCalledExactlyOnceWith(mediaId);
    expect(navigate).not.toHaveBeenCalled();
  },
);
it('keeps an unavailable saved filter tuple through keyboard submit without choosing a new head', async () => {
  const filters = { ...query.filters, courseLink: link };
  const { user, navigate } = setup({ filters, courses: [] });
  expect(screen.getByRole('option', { name: '선택한 코스 리비전 정보 없음' })).toBeDisabled();
  screen.getByRole('button', { name: '필터 적용' }).focus();
  await user.keyboard('{Enter}');
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ ...query, filters, cursor: null });
});

it('keeps partial and reversed local date drafts visible and blocks invalid navigation', async () => {
  const { user, navigate } = setup();
  await user.selectOptions(screen.getByLabelText('촬영일'), 'stored_local_range');
  expect(screen.getByRole('button', { name: '필터 적용' })).toBeDisabled();
  await user.type(screen.getByLabelText('시작 촬영일'), '2026-10-10');
  await user.type(screen.getByLabelText('마지막 촬영일 (포함)'), '2026-10-09');
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByRole('button', { name: '필터 적용' })).toBeDisabled();
  expect(navigate).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText('마지막 촬영일 (포함)'));
  await user.type(screen.getByLabelText('마지막 촬영일 (포함)'), '2026-10-11');
  await user.click(screen.getByRole('button', { name: '필터 적용' }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    ...query,
    filters: {
      ...query.filters,
      capturedDay: { mode: 'stored_local_range', from: '2026-10-10', toInclusive: '2026-10-11' },
    },
  });
});

it('uses the validated continuation and prevents mixing it with unapplied filters', async () => {
  const supplied = page(true);
  const { user, navigate } = setup({ result: { state: 'ready', page: supplied } });
  await user.click(screen.getByRole('button', { name: '다음 페이지' }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    ...supplied.query,
    cursor: supplied.nextCursor,
  });
  await user.selectOptions(screen.getByLabelText('앨범'), 'unassigned');
  expect(screen.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '필터 적용' }));
  expect(navigate).toHaveBeenLastCalledWith({
    ...query,
    filters: { ...query.filters, album: { mode: 'unassigned' } },
    cursor: null,
  });
});

it('preserves stored local date despite a different UTC day, and distinguishes missing facts', async () => {
  const first = setup({ result: { state: 'ready', page: page(false, true) } });
  const card = screen.getByRole('listitem');
  expect(within(card).getByText('2026-10-08')).toBeVisible();
  expect(within(card).getByText('촬영 시각 저장됨 · 촬영 시간대 정보 없음')).toBeVisible();
  expect(within(card).getByText('앨범 미지정')).toBeVisible();
  expect(within(card).getByText('코스 연결 없음')).toBeVisible();
  await first.user.click(screen.getByRole('button', { name: '결승선' }));
  expect(first.openMedia).toHaveBeenCalledExactlyOnceWith(mediaId);
  first.unmount();
  const second = setup();
  expect(within(screen.getByRole('listitem')).getByText('촬영일 알 수 없음')).toBeVisible();
  await second.user.selectOptions(screen.getByLabelText('촬영일'), 'unknown');
  await second.user.click(screen.getByRole('button', { name: '필터 적용' }));
  expect(second.navigate).toHaveBeenCalledExactlyOnceWith({
    ...query,
    filters: { ...query.filters, capturedDay: { mode: 'unknown' } },
  });
});

it.each(['error', 'conflict'] as const)(
  'offers an explicit reload for %s without inventing a ready page',
  async (state) => {
    const { user, reload, navigate } = setup({ result: { state } });
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '처음부터 다시 불러오기' }));
    expect(reload).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  },
);

it('shows loading and absent API capability honestly and disables their controls', () => {
  const first = setup({ result: { state: 'loading' } });
  expect(screen.getByRole('region', { name: '갤러리 탐색' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByLabelText('앨범')).toBeDisabled();
  first.unmount();
  setup({ actions: null, result: { state: 'unavailable' } });
  expect(screen.getByText('이 환경에서는 갤러리 탐색 연결을 사용할 수 없습니다.')).toBeVisible();
  expect(screen.getByLabelText('연결된 코스 리비전')).toBeDisabled();
  expect(screen.getByRole('button', { name: '필터 적용' })).toBeDisabled();
});

it('shows an explicit empty last page without a continuation or fabricated total', () => {
  const empty = galleryMediaNavigationPageV3Schema.parse({
    schemaVersion: 3,
    query,
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  setup({ result: { state: 'ready', page: empty } });
  expect(screen.getByText('조건에 맞는 사진·동영상이 없습니다.')).toBeVisible();
  expect(screen.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('does not pretend a missing media viewer is available', () => {
  setup({
    actions: { changeFilters: vi.fn(), navigate: vi.fn(), reload: vi.fn(), openMedia: null },
  });
  expect(screen.getByRole('button', { name: '결승선' })).toBeDisabled();
  expect(screen.getByText('이 환경에서는 미디어 열기를 사용할 수 없습니다.')).toBeVisible();
});

it('composes one workspace grid with independent controls and exact cursor navigation', async () => {
  const navigate = vi.fn();
  const openMedia = vi.fn();
  const currentPage = page(true);
  const actions = { changeFilters: vi.fn(), navigate, reload: vi.fn(), openMedia };
  const props = {
    filters: query.filters,
    limit: query.limit,
    albums: [album],
    courses: [{ label: '강변', link }],
    result: { state: 'ready', page: currentPage } as const,
    actions,
  };
  const view = render(
    <>
      <GalleryNavigationControls {...props} />
      <GalleryNavigationResultFrame {...props}>
        <ul aria-label="워크스페이스 미디어">
          <li>
            <button type="button" onClick={() => openMedia(mediaId)}>
              미리보기 열기
            </button>
          </li>
        </ul>
      </GalleryNavigationResultFrame>
    </>,
  );
  const user = userEvent.setup();
  expect(screen.getAllByRole('list')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '결승선' })).not.toBeInTheDocument();
  expect(screen.getByText('이 페이지에 1개 · 다음 페이지 있음')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '미리보기 열기' }));
  expect(openMedia).toHaveBeenCalledExactlyOnceWith(mediaId);
  await user.click(screen.getByRole('button', { name: '다음 페이지' }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ ...query, cursor: currentPage.nextCursor });
  navigate.mockClear();
  view.rerender(
    <GalleryNavigationResultFrame
      {...props}
      filters={{ ...query.filters, capturedDay: { mode: 'unknown' } }}
    >
      <ul aria-label="워크스페이스 미디어">
        <li>현재 페이지 미리보기</li>
      </ul>
    </GalleryNavigationResultFrame>,
  );
  expect(screen.getByRole('list', { name: '워크스페이스 미디어' })).toBeVisible();
  expect(screen.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '다음 페이지' }));
  expect(navigate).not.toHaveBeenCalled();
});

it.each(['loading', 'error', 'conflict', 'unavailable'] as const)(
  'keeps supplied private result content unmounted while the frame is %s',
  async (state) => {
    const reload = vi.fn();
    const actions = { changeFilters: vi.fn(), navigate: vi.fn(), reload, openMedia: vi.fn() };
    render(
      <GalleryNavigationResultFrame
        filters={query.filters}
        limit={query.limit}
        result={{ state }}
        actions={actions}
      >
        <button type="button">현재 페이지 미리보기</button>
      </GalleryNavigationResultFrame>,
    );
    expect(screen.queryByRole('button', { name: '현재 페이지 미리보기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다음 페이지' })).not.toBeInTheDocument();
    if (state === 'error' || state === 'conflict') {
      await userEvent.setup().click(screen.getByRole('button', { name: '처음부터 다시 불러오기' }));
      expect(reload).toHaveBeenCalledOnce();
    } else {
      expect(screen.getByRole('status')).toBeVisible();
      expect(reload).not.toHaveBeenCalled();
    }
    expect(actions.navigate).not.toHaveBeenCalled();
  },
);

it('does not mount a supplied grid for a validated empty current page', () => {
  const empty = galleryMediaNavigationPageV3Schema.parse({
    schemaVersion: 3,
    query,
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  render(
    <GalleryNavigationResultFrame
      filters={query.filters}
      limit={query.limit}
      result={{ state: 'ready', page: empty }}
      actions={{ changeFilters: vi.fn(), navigate: vi.fn(), reload: vi.fn(), openMedia: vi.fn() }}
    >
      <ul aria-label="워크스페이스 미디어">
        <li>이전 페이지 미리보기</li>
      </ul>
    </GalleryNavigationResultFrame>,
  );
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(screen.getByText('조건에 맞는 사진·동영상이 없습니다.')).toBeVisible();
  expect(screen.getByText('이 페이지에 0개 · 마지막 페이지')).toBeVisible();
  expect(screen.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
});

it('keeps a saved rev4 draft when current choices move to rev5, without applying automatically', async () => {
  const user = userEvent.setup();
  const f = setup({
    filters: { ...query.filters, courseLink: link },
    courses: [{ label: '내 코스', link: { ...link, courseRevision: 5 } }],
    courseChoices: { state: 'ready', unavailableCount: 0, reload: vi.fn() },
  });
  const select = screen.getByRole('combobox', { name: '연결된 코스 리비전' });
  expect(select).toHaveValue(`${link.courseId}:4:${link.revisionId}`);
  expect(screen.getByRole('option', { name: '선택한 코스 리비전 정보 없음' })).toBeDisabled();
  expect(f.navigate).not.toHaveBeenCalled();
  await user.selectOptions(select, `${link.courseId}:5:${link.revisionId}`);
  expect(f.navigate).not.toHaveBeenCalled();
});
it.each(['unavailable', 'loading', 'error'] as const)(
  'distinguishes course choices %s from ready empty',
  (state) => {
    const reload = vi.fn();
    setup({ courses: [], courseChoices: state === 'error' ? { state, reload } : { state } });
    expect(screen.getByRole('combobox', { name: '연결된 코스 리비전' })).toBeDisabled();
    expect(screen.queryByText('현재 선택 가능한 코스 버전이 없습니다.')).not.toBeInTheDocument();
    expect(
      state === 'error'
        ? screen.getByText(/코스 버전 목록을 불러오지 못했습니다/)
        : screen.getByText(
            state === 'loading'
              ? '현재 코스 버전 목록을 불러오는 중입니다.'
              : '이 환경에서는 코스 버전 목록 조회를 사용할 수 없습니다.',
          ),
    ).toBeInTheDocument();
  },
);
it('presents real empty choices with explicit reload and current-head scope', async () => {
  const reload = vi.fn();
  setup({ courses: [], courseChoices: { state: 'ready', unavailableCount: 1, reload } });
  expect(screen.getByText('현재 선택 가능한 코스 버전이 없습니다.')).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: '코스 목록 다시 조회' }));
  expect(reload).toHaveBeenCalledTimes(1);
});
