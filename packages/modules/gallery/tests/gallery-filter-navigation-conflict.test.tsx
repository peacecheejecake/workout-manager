import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  galleryMediaNavigationQueryV2Schema,
  type GalleryMediaNavigationQueryV2,
} from '@workout/contracts/gallery-navigation-v2';
import { createGalleryNavigationApi } from '../src/gallery-navigation-api';
import { createDefaultGalleryNavigationQuery } from '../src/gallery-navigation-search';
import { GalleryWorkspace } from '../src/gallery-workspace';

afterEach(cleanup);
const start = createDefaultGalleryNavigationQuery();
const next = galleryMediaNavigationQueryV2Schema.parse({
  ...start,
  filters: { ...start.filters, album: { mode: 'unassigned' } },
});
const notice = '화면 이동으로 목록 필터가 바뀌었습니다. 편집 중인 필터는 보존했습니다.';
const album = {
  schemaVersion: 1,
  id: '10000000-0000-4000-8000-000000000002',
  title: '기록',
  revision: 1,
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};
function fixture() {
  const requests: TransportRequest[] = [];
  let rejectWrite!: (reason: unknown) => void;
  const write = new Promise<ReturnType<typeof transportReplySchema.parse>>((_, reject) => {
    rejectWrite = reject;
  });
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      requests.push(input);
      if (input.method !== 'GET') return write;
      const query: unknown = JSON.parse(
        new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null',
      );
      return transportReplySchema.parse({
        status: 200,
        traceId: null,
        body: input.path.includes('/media/navigation?')
          ? { schemaVersion: 3, query, items: [], hasMore: false, nextCursor: null }
          : { schemaVersion: 1, query, items: [album], hasMore: false, nextCursor: null },
      });
    },
  };
  const api = createGalleryNavigationApi(transport);
  const onNavigate = vi.fn();
  const view = (externalQuery: GalleryMediaNavigationQueryV2) => (
    <GalleryWorkspace
      athleteId="alice"
      sessionId="one"
      transport={transport}
      navigation={{ api, initialQuery: start, externalQuery, onNavigate }}
    />
  );
  return { ...render(view(start)), view, requests, rejectWrite, onNavigate };
}
it.each([
  ['이동한 화면의 필터 사용', 'all', 'unassigned'],
  ['편집 중인 필터 유지', 'unknown', 'all'],
])(
  'resolves history conflict with %s while retaining album drafts and its pending command',
  async (button, day, selectedAlbum) => {
    const user = userEvent.setup();
    const f = fixture();
    await screen.findByRole('button', { name: '기록 이름 변경' });
    await waitFor(() => expect(screen.getByLabelText('촬영일')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('촬영일'), 'unknown');
    await user.type(screen.getByLabelText('새 앨범 제목'), '새 초안');
    await user.click(screen.getByRole('button', { name: '기록 이름 변경' }));
    await user.clear(screen.getByLabelText('변경할 앨범 제목'));
    await user.type(screen.getByLabelText('변경할 앨범 제목'), '변경 초안');
    await user.click(screen.getByRole('button', { name: '기록 삭제 대상 선택' }));
    await user.click(screen.getByRole('button', { name: '앨범 만들기' }));
    await screen.findByText('앨범 만들기 요청을 처리하는 중입니다.');
    const command = f.requests.find((r) => r.method !== 'GET');
    const key = command?.idempotencyKey;
    expect(key).toMatch(/^[a-f0-9-]{36}$/);
    f.rerender(f.view(next));
    expect(screen.getAllByText(notice)).toHaveLength(1);
    expect(screen.getByLabelText('촬영일')).toHaveValue('unknown');
    await user.click(screen.getByRole('button', { name: button }));
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    expect(screen.getByLabelText('촬영일')).toHaveValue(day);
    expect(screen.getByLabelText('앨범', { selector: 'select' })).toHaveValue(selectedAlbum);
    expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('새 초안');
    expect(screen.getByLabelText('변경할 앨범 제목')).toHaveValue('변경 초안');
    expect(screen.getByText('삭제 대상: 기록')).toBeInTheDocument();
    expect(command?.signal?.aborted).toBe(false);
    expect(screen.getByText('앨범 만들기 요청을 처리하는 중입니다.')).toBeInTheDocument();
    expect(f.onNavigate).not.toHaveBeenCalled();
    expect(f.requests.filter((r) => r.method !== 'GET')).toHaveLength(1);
    f.rejectWrite(new Error('DISCONNECTED'));
    await screen.findByText(
      '서버 처리 결과를 아직 확인하지 못했습니다. 제목과 대상은 유지됩니다. 결과를 확인하기 전에는 편집하거나 다시 보내지 않습니다.',
    );
    expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
    expect(command?.idempotencyKey).toBe(key);
    expect(f.onNavigate).not.toHaveBeenCalled();
  },
);
it('preserves legacy navigation-unavailable behavior without presenting conflict choices', async () => {
  const transport: AuthenticatedTransport = {
    request: async () =>
      transportReplySchema.parse({ status: 200, traceId: null, body: { items: [], total: 0 } }),
  };
  render(<GalleryWorkspace athleteId="alice" sessionId="one" transport={transport} />);
  await screen.findByText('아직 저장한 사진이나 동영상이 없습니다.');
  expect(
    screen.getByText('이 환경에서는 갤러리 탐색 연결을 사용할 수 없습니다.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '필터 적용' })).toBeDisabled();
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '이동한 화면의 필터 사용' })).not.toBeInTheDocument();
});
