import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  galleryAlbumListPageV1Schema,
  galleryAlbumV1Schema,
  type GalleryAlbumRenameCommandV1,
} from '@workout/contracts/gallery-navigation-v2';
import {
  GalleryAlbums,
  type GalleryAlbumsProps,
  type GalleryAlbumDeleteTarget,
} from '../src/gallery-albums';

afterEach(cleanup);
const id = '10000000-0000-4000-8000-000000000001';
const album = galleryAlbumV1Schema.parse({
  schemaVersion: 1,
  id,
  title: '대회',
  revision: 2,
  createdAt: '2026-10-09T00:00:00.000001Z',
  updatedAt: '2026-10-09T00:00:00.000001Z',
});
const query = { limit: 1, sort: 'created_desc_id_asc', cursor: null } as const;
function page(hasMore = false) {
  return galleryAlbumListPageV1Schema.parse({
    schemaVersion: 1,
    query,
    items: [album],
    hasMore,
    nextCursor: hasMore
      ? {
          cursorVersion: 1,
          binding: { limit: 1, sort: query.sort },
          after: { createdAt: album.createdAt, id },
        }
      : null,
  });
}
function setup(initial: Partial<GalleryAlbumsProps> = {}) {
  let props = initial;
  const actions = {
    changeCreateTitle: vi.fn(),
    changeRenameTitle: vi.fn(),
    beginRename: vi.fn(),
    cancelRename: vi.fn(),
    requestDelete: vi.fn(),
    cancelDelete: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    navigate: vi.fn(),
    reload: vi.fn(),
  };
  function Controlled() {
    const [createTitle, setCreateTitle] = useState(initial.createTitle ?? '');
    const [renameDraft, setRenameDraft] = useState<GalleryAlbumRenameCommandV1 | null>(
      initial.renameDraft ?? null,
    );
    const [deleteTarget, setDeleteTarget] = useState<GalleryAlbumDeleteTarget | null>(
      initial.deleteTarget ?? null,
    );
    return (
      <GalleryAlbums
        result={{ state: 'ready', page: page() }}
        operation={{ state: 'idle' }}
        {...props}
        createTitle={createTitle}
        renameDraft={renameDraft}
        deleteTarget={deleteTarget}
        actions={
          props.actions === null
            ? null
            : {
                ...actions,
                changeCreateTitle: (value) => {
                  actions.changeCreateTitle(value);
                  setCreateTitle(value);
                },
                changeRenameTitle: (value) => {
                  actions.changeRenameTitle(value);
                  setRenameDraft((draft) => (draft === null ? null : { ...draft, title: value }));
                },
                beginRename: (value) => {
                  actions.beginRename(value);
                  setRenameDraft({
                    albumId: value.id,
                    expectedRevision: value.revision,
                    title: value.title,
                  });
                },
                cancelRename: () => {
                  actions.cancelRename();
                  setRenameDraft(null);
                },
                requestDelete: (value) => {
                  actions.requestDelete(value);
                  setDeleteTarget({ album: value, detachedMediaCount: null });
                },
                cancelDelete: () => {
                  actions.cancelDelete();
                  setDeleteTarget(null);
                },
              }
        }
      />
    );
  }
  const view = render(<Controlled />);
  return {
    actions,
    user: userEvent.setup(),
    ...view,
    update: (patch: Partial<GalleryAlbumsProps>) => {
      props = { ...props, ...patch };
      view.rerender(<Controlled />);
    },
  };
}

it('creates only after a labelled explicit keyboard submission and preserves the draft', async () => {
  const { user, actions } = setup();
  const title = screen.getByLabelText('새 앨범 제목');
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
  await user.type(title, ' 새 앨범 ');
  expect(actions.create).not.toHaveBeenCalled();
  await user.keyboard('{Enter}');
  expect(actions.create).toHaveBeenCalledExactlyOnceWith({ title: '새 앨범' });
  expect(title).toHaveValue(' 새 앨범 ');
});

it('renames the explicitly selected revision and never substitutes a newer list revision into its draft', async () => {
  const { user, actions, update } = setup();
  await user.click(screen.getByRole('button', { name: '대회 이름 변경' }));
  expect(actions.rename).not.toHaveBeenCalled();
  const title = screen.getByLabelText('변경할 앨범 제목');
  await user.clear(title);
  await user.type(title, '미저장 제목');
  const refreshed = galleryAlbumListPageV1Schema.parse({
    ...page(),
    items: [{ ...album, revision: 7 }],
  });
  update({ result: { state: 'ready', page: refreshed } });
  expect(title).toHaveValue('미저장 제목');
  await user.click(screen.getByRole('button', { name: '앨범 이름 저장' }));
  expect(actions.rename).toHaveBeenCalledExactlyOnceWith({
    albumId: id,
    expectedRevision: 2,
    title: '미저장 제목',
  });
});

it('requires a visible frozen delete target and explains unknown detach count and original preservation before deletion', async () => {
  const { user, actions } = setup();
  await user.click(screen.getByRole('button', { name: '대회 삭제 대상 선택' }));
  expect(actions.delete).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('region', { name: '앨범 삭제 확인' });
  expect(within(confirmation).getByText('삭제 대상: 대회')).toBeVisible();
  expect(within(confirmation).getByText(`앨범 ID ${id} · 선택한 리비전 2`)).toBeVisible();
  expect(
    within(confirmation).getByText(
      '이 앨범과의 미디어 연결이 해제됩니다. 미디어 원본 파일은 삭제하지 않습니다.',
    ),
  ).toBeVisible();
  expect(within(confirmation).getByText('연결 해제 대상 수는 알 수 없습니다.')).toBeVisible();
  await user.click(within(confirmation).getByRole('button', { name: '이 앨범 삭제 확인' }));
  expect(actions.delete).toHaveBeenCalledExactlyOnceWith({ albumId: id, expectedRevision: 2 });
});

it('allows cancelling a selected deletion without a mutation and distinguishes a known zero count', async () => {
  const { user, actions } = setup({ deleteTarget: { album, detachedMediaCount: 0 } });
  expect(screen.getByText('연결 해제 대상 0개')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '앨범 삭제 취소' }));
  expect(actions.cancelDelete).toHaveBeenCalledOnce();
  expect(actions.delete).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '앨범 삭제 확인' })).not.toBeInTheDocument();
});

it('navigates exactly one supplied page continuation without assuming an entire album list', async () => {
  const supplied = page(true);
  const { user, actions, update } = setup({ result: { state: 'ready', page: supplied } });
  expect(screen.getByText('이 페이지에 1개 · 전체 앨범 수는 알 수 없습니다.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '다음 앨범 페이지' }));
  expect(actions.navigate).toHaveBeenCalledExactlyOnceWith({
    ...supplied.query,
    cursor: supplied.nextCursor,
  });
  update({ result: { state: 'ready', page: page() } });
  expect(screen.getByRole('button', { name: '다음 앨범 페이지' })).toBeDisabled();
});

it('shows a bounded empty page and a failed continuation without clearing a title draft', () => {
  const empty = galleryAlbumListPageV1Schema.parse({
    schemaVersion: 1,
    query,
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  const { update } = setup({
    createTitle: '남아 있는 제목',
    result: { state: 'ready', page: empty },
  });
  expect(screen.getByText('현재 페이지에 앨범이 없습니다.')).toBeVisible();
  expect(screen.getByRole('button', { name: '다음 앨범 페이지' })).toBeDisabled();
  update({ result: { state: 'error' } });
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('남아 있는 제목');
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('preserves a typed title on operation conflict and blocks stale command retransmission until the parent resolves it', async () => {
  const { user, actions, update } = setup({
    renameDraft: { albumId: id, expectedRevision: 2, title: '미저장 제목' },
  });
  update({ operation: { state: 'conflict', kind: 'rename' } });
  expect(screen.getByLabelText('변경할 앨범 제목')).toHaveValue('미저장 제목');
  expect(screen.getByRole('button', { name: '앨범 이름 저장' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '앨범 이름 저장' }));
  expect(actions.rename).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '변경된 앨범 다시 확인하기' }));
  expect(actions.reload).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('변경할 앨범 제목')).toHaveValue('미저장 제목');
  expect(screen.getByRole('button', { name: '앨범 이름 저장' })).toBeDisabled();
});

it.each(['submitting', 'uncertain'] as const)(
  'locks edits, targets and resend during %s while retaining all drafts',
  async (state) => {
    const { user, actions } = setup({
      createTitle: '새 제목',
      renameDraft: { albumId: id, expectedRevision: 2, title: '변경 제목' },
      deleteTarget: { album, detachedMediaCount: null },
      operation: { state, kind: 'delete' },
    });
    expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('새 제목');
    expect(screen.getByLabelText('변경할 앨범 제목')).toHaveValue('변경 제목');
    for (const label of ['새 앨범 제목', '변경할 앨범 제목'])
      expect(screen.getByLabelText(label)).toBeDisabled();
    for (const name of [
      '앨범 만들기',
      '앨범 이름 저장',
      '이 앨범 삭제 확인',
      '앨범 삭제 취소',
      '이름 변경 취소',
      '대회 삭제 대상 선택',
      '다음 앨범 페이지',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '이 앨범 삭제 확인' }));
    expect(actions.delete).not.toHaveBeenCalled();
    expect(actions.create).not.toHaveBeenCalled();
    expect(actions.rename).not.toHaveBeenCalled();
    if (state === 'uncertain') {
      await user.click(screen.getByRole('button', { name: '처리 결과 확인' }));
      expect(actions.reload).toHaveBeenCalledOnce();
      expect(actions.delete).not.toHaveBeenCalled();
    }
  },
);

it('shows operation failure without successful removal or clearing the frozen selection', () => {
  setup({
    deleteTarget: { album, detachedMediaCount: null },
    operation: { state: 'error', kind: 'delete' },
  });
  expect(screen.getByRole('alert')).toHaveTextContent('앨범 삭제 요청에 실패했습니다.');
  expect(screen.getByRole('region', { name: '앨범 삭제 확인' })).toBeVisible();
  expect(screen.getByRole('listitem')).toHaveTextContent('대회');
});

it('shows loading and unavailable capabilities honestly without losing drafts', () => {
  const { update } = setup({ createTitle: '미저장 제목', result: { state: 'loading' } });
  expect(screen.getByRole('region', { name: '앨범 관리' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: '앨범 만들기' })).toBeDisabled();
  update({ result: { state: 'unavailable' }, actions: null });
  expect(
    screen.getByText(
      '이 환경에서는 앨범 관리 연결을 사용할 수 없습니다. 작성한 제목은 유지됩니다.',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('새 앨범 제목')).toHaveValue('미저장 제목');
  expect(screen.getByLabelText('새 앨범 제목')).toBeDisabled();
});
