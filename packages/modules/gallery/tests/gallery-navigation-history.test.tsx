import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
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
import { useGalleryNavigationWorkspace } from '../src/use-gallery-navigation-workspace';

const scope = ['gallery', 'alice', 'one'];
const album = {
  schemaVersion: 1 as const,
  id: '10000000-0000-4000-8000-000000000002',
  title: '기록',
  revision: 1,
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};
const start = createDefaultGalleryNavigationQuery();
const next = galleryMediaNavigationQueryV2Schema.parse({
  ...start,
  filters: { ...start.filters, capturedDay: { mode: 'unknown' } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(options: { holdRead?: boolean; holdWrite?: boolean } = {}) {
  const requests: TransportRequest[] = [];
  const read = deferred<ReturnType<typeof transportReplySchema.parse>>();
  const write = deferred<ReturnType<typeof transportReplySchema.parse>>();
  const transport: AuthenticatedTransport = {
    request: async (input) => {
      requests.push(input);
      if (input.method !== 'GET' && options.holdWrite) return write.promise;
      const query: unknown = JSON.parse(
        new URL(input.path, 'http://localhost').searchParams.get('query') ?? 'null',
      );
      if (input.path.includes('/media/navigation?')) {
        if (
          options.holdRead &&
          requests.filter((r) => r.path.includes('/media/navigation?')).length === 1
        )
          return read.promise;
        return transportReplySchema.parse({
          status: 200,
          traceId: null,
          body: { schemaVersion: 3, query, items: [], hasMore: false, nextCursor: null },
        });
      }
      return transportReplySchema.parse({
        status: 200,
        traceId: null,
        body: { schemaVersion: 1, query, items: [album], hasMore: false, nextCursor: null },
      });
    },
  };
  const api = createGalleryNavigationApi(transport);
  const onNavigate = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ externalQuery }: { externalQuery: GalleryMediaNavigationQueryV2 }) =>
      useGalleryNavigationWorkspace(
        scope,
        { api, initialQuery: start, externalQuery, onNavigate },
        null,
      ),
    { wrapper, initialProps: { externalQuery: start } },
  );
  return { ...hook, requests, read, write, onNavigate, client };
}

it('reflects back and forward query inputs without remount or URL feedback, retaining all album drafts', async () => {
  const f = fixture();
  await waitFor(() => expect(f.result.current.result.state).toBe('ready'));
  act(() => {
    f.result.current.albumProps.actions?.changeCreateTitle('만드는 중');
    f.result.current.albumProps.actions?.beginRename(album);
    f.result.current.albumProps.actions?.changeRenameTitle('고칠 제목');
    f.result.current.albumProps.actions?.requestDelete(album);
  });
  f.rerender({ externalQuery: next });
  await waitFor(() => expect(f.result.current.query).toEqual(next));
  expect(f.result.current.filters).toEqual(next.filters);
  f.rerender({ externalQuery: start });
  await waitFor(() => expect(f.result.current.query).toEqual(start));
  expect(f.result.current.albumProps.createTitle).toBe('만드는 중');
  expect(f.result.current.albumProps.renameDraft?.title).toBe('고칠 제목');
  expect(f.result.current.albumProps.deleteTarget?.album).toEqual(album);
  expect(f.onNavigate).not.toHaveBeenCalled();
  f.unmount();
});
it('keeps a dirty filter draft and resolves its external-navigation conflict explicitly', async () => {
  const f = fixture();
  const draft = { ...start.filters, mediaKind: 'video' as const };
  act(() => f.result.current.controls.changeFilters(draft));
  f.rerender({ externalQuery: next });
  expect(f.result.current.query).toEqual(next);
  expect(f.result.current.filters).toEqual(draft);
  expect(f.result.current.filterNavigationConflict.state).toBe('draft_conflict');
  act(() => f.result.current.controls.resolveFilterNavigation('keep_draft'));
  expect(f.result.current.filters).toEqual(draft);
  expect(f.result.current.filterNavigationConflict.state).toBe('idle');
  f.rerender({ externalQuery: start });
  expect(f.result.current.filterNavigationConflict.state).toBe('draft_conflict');
  act(() => f.result.current.controls.resolveFilterNavigation('use_external'));
  expect(f.result.current.filters).toEqual(start.filters);
  expect(f.onNavigate).not.toHaveBeenCalled();
  f.unmount();
});
it('ignores equivalent reordered inputs and applied-query echoes without repeated callbacks or reads', async () => {
  const f = fixture();
  await waitFor(() => expect(f.result.current.result.state).toBe('ready'));
  act(() => f.result.current.controls.navigate(next));
  await waitFor(() => expect(f.result.current.result.state).toBe('ready'));
  act(() => f.result.current.controls.changeFilters({ ...next.filters, mediaKind: 'image' }));
  const count = f.requests.length;
  f.rerender({
    externalQuery: {
      cursor: next.cursor,
      sort: next.sort,
      limit: next.limit,
      filters: next.filters,
    },
  });
  expect(f.result.current.filters.mediaKind).toBe('image');
  expect(f.result.current.filterNavigationConflict.state).toBe('idle');
  act(() => f.result.current.controls.navigate(next));
  expect(f.onNavigate).toHaveBeenCalledTimes(1);
  expect(f.requests).toHaveLength(count);
  f.unmount();
});
it('cancels only an obsolete page read during external navigation and ignores its late body', async () => {
  const f = fixture({ holdRead: true });
  await waitFor(() =>
    expect(f.requests.some((r) => r.path.includes('/media/navigation?'))).toBe(true),
  );
  const old = f.requests.find((r) => r.path.includes('/media/navigation?'));
  const albums = f.requests.find((r) => r.path.includes('/albums?'));
  f.rerender({ externalQuery: next });
  await waitFor(() => expect(old?.signal?.aborted).toBe(true));
  await waitFor(() => expect(f.result.current.result.state).toBe('ready'));
  expect(albums?.signal?.aborted).toBe(false);
  f.read.resolve(
    transportReplySchema.parse({
      status: 200,
      traceId: null,
      body: { schemaVersion: 3, query: start, items: [], hasMore: false, nextCursor: null },
    }),
  );
  await act(async () => {
    await f.read.promise;
  });
  expect(f.result.current.result.state === 'ready' && f.result.current.result.page.query).toEqual(
    next,
  );
  expect(f.onNavigate).not.toHaveBeenCalled();
  f.unmount();
});
it.each(['create', 'rename', 'delete'] as const)(
  'preserves the %s command key, pending state and uncertain outcome across history changes',
  async (kind) => {
    const f = fixture({ holdWrite: true });
    await waitFor(() => expect(f.result.current.albumProps.result.state).toBe('ready'));
    act(() => {
      const actions = f.result.current.albumProps.actions;
      actions?.changeCreateTitle('새 초안');
      actions?.beginRename(album);
      actions?.changeRenameTitle('변경 초안');
      actions?.requestDelete(album);
      if (kind === 'create') actions?.create({ title: '새 초안' });
      else if (kind === 'rename')
        actions?.rename({ albumId: album.id, expectedRevision: 1, title: '변경 초안' });
      else actions?.delete({ albumId: album.id, expectedRevision: 1 });
    });
    await waitFor(() =>
      expect(f.result.current.albumProps.operation).toEqual({ state: 'submitting', kind }),
    );
    const request = f.requests.find((r) => r.method !== 'GET');
    const key = request?.idempotencyKey;
    expect(key).toMatch(/^[a-f0-9-]{36}$/);
    f.rerender({ externalQuery: next });
    expect(request?.signal?.aborted).toBe(false);
    expect(f.result.current.albumProps.operation).toEqual({ state: 'submitting', kind });
    f.write.reject(new Error('DISCONNECTED'));
    await waitFor(() =>
      expect(f.result.current.albumProps.operation).toEqual({ state: 'uncertain', kind }),
    );
    f.rerender({ externalQuery: start });
    expect(f.result.current.albumProps.operation).toEqual({ state: 'uncertain', kind });
    expect(f.result.current.albumProps.createTitle).toBe('새 초안');
    expect(f.result.current.albumProps.renameDraft?.title).toBe('변경 초안');
    expect(f.result.current.albumProps.deleteTarget?.album).toEqual(album);
    act(() => f.result.current.albumProps.actions?.create({ title: '재전송 금지' }));
    expect(f.requests.filter((r) => r.method !== 'GET')).toHaveLength(1);
    expect(request?.idempotencyKey).toBe(key);
    f.unmount();
  },
);
