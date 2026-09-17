import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { ActivityBatchTags } from '../src/activity-batch-tags';
import { ActivityBatchDelete } from '../src/activity-batch-delete';
import { ActivityBatchLink } from '../src/activity-batch-link';
import { ActivityBatchExport } from '../src/activity-batch-export';
import { ActivityBrowser } from '../src/activity-browser';
import { BrowserRecords, BrowserDetail } from '../src/browser-records';
import { createBatchSelectionStore, toBatchTarget } from '../src/batch-selection';
import { readActivitySearch } from '../src/browser-search';
import { tagActivity, tagResponse } from './tag-fixtures';
function setup(request: AuthenticatedTransport['request'], workflows = false) {
  const store = createBatchSelectionStore();
  store.getState().selectPage([toBatchTarget(tagActivity())]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const props = {
    store,
    transport: { request },
    scope: ['users', 'alice', 'session'],
    createId: () => 'stable-tag-key',
  };
  const view = render(
    <QueryClientProvider client={client}>
      <ActivityBatchTags {...props} />
      {workflows ? (
        <>
          <ActivityBatchDelete {...props} onDeleted={() => {}} />
          <ActivityBatchLink {...props} />
          <ActivityBatchExport {...props} />
        </>
      ) : null}
    </QueryClientProvider>,
  );
  return { ...view, store, client, props };
}
async function preview(tag = '새 태그') {
  fireEvent.change(screen.getByRole('textbox', { name: '변경할 로컬 태그' }), {
    target: { value: tag },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '일괄 태그 변경 사유' }), {
    target: { value: '합성 분류' },
  });
  await userEvent.click(screen.getByRole('button', { name: '태그 변경 미리보기' }));
  await screen.findByRole('button', { name: '태그 변경 확인' });
}
describe('batch tags confirmation and workspace integration', () => {
  it('locks the other workflows before explicit confirmation, preserves selection and input on cancel, and returns focus', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current')
        ? tagResponse({ head: null, history: [] })
        : tagResponse(tagActivity()),
    );
    const { store } = setup(request, true);
    await preview();
    expect(store.getState().locked).toBe(true);
    expect(screen.getByRole('button', { name: '태그 변경 취소' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '계획 연결 변경 미리보기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '선택 활동 내보내기 미리보기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' })).toBeDisabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '태그 변경 취소' }));
    expect(store.getState().targets).toHaveLength(1);
    expect(store.getState().locked).toBe(false);
    expect(screen.getByRole('textbox', { name: '변경할 로컬 태그' })).toHaveValue('새 태그');
    expect(screen.getByRole('button', { name: '태그 변경 미리보기' })).toHaveFocus();
    act(() => store.getState().setLocked(true));
    expect(screen.getByRole('button', { name: '태그 변경 미리보기' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '변경할 로컬 태그' })).toBeDisabled();
  });

  it('requires a reason, previews no-ops, and retries only the uncertain frozen command', async () => {
    let writes = 0;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (input.method === 'GET') return tagResponse(tagActivity());
      writes++;
      return writes === 1
        ? tagResponse(null, 503)
        : tagResponse({ ...tagActivity(['새 태그']), revision: 3 });
    });
    const { store } = setup(request);
    await userEvent.click(screen.getByRole('button', { name: '태그 변경 미리보기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('정정 사유');
    expect(request).not.toHaveBeenCalled();
    await preview();
    await userEvent.click(screen.getByRole('button', { name: '태그 변경 확인' }));
    await screen.findByRole('button', { name: '미확인 태그 변경 다시 확인' });
    expect(store.getState().targets).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '미확인 태그 변경 다시 확인' }));
    await waitFor(() => expect(store.getState().targets).toHaveLength(0));
    const calls = request.mock.calls
      .filter(([input]) => input.method === 'PATCH')
      .map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual(calls[1]?.body);
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);
    expect(calls[0]?.body).toEqual({ expectedRevision: 2, reason: '합성 분류', tags: ['새 태그'] });
    await userEvent.click(screen.getByRole('button', { name: '태그 변경 결과 닫기' }));
    expect(store.getState().locked).toBe(false);
  });

  it('shows capacity and no-op items without offering an enabled write, and retains targets', async () => {
    const original = tagActivity(Array.from({ length: 20 }, (_, index) => `tag${index}`));
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue(tagResponse(original));
    const { store } = setup(request);
    await preview();
    expect(screen.getByText(/태그 최대 20개 초과/)).toBeVisible();
    expect(screen.getByRole('button', { name: '태그 변경 확인' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '태그 변경 취소' }));
    await preview('tag0');
    expect(screen.getByText(/같은 태그 상태: 변경하지 않음/)).toBeVisible();
    expect(screen.getByRole('button', { name: '태그 변경 확인' })).toBeDisabled();
    expect(store.getState().targets).toHaveLength(1);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('aborts late reads and resets the private workflow on account scope replacement', async () => {
    let resolve:
      ((reply: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void) | undefined;
    const request = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { rerender, props, client, store } = setup(request);
    fireEvent.change(screen.getByRole('textbox', { name: '변경할 로컬 태그' }), {
      target: { value: '개인 태그' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '일괄 태그 변경 사유' }), {
      target: { value: '합성 분류' },
    });
    await userEvent.click(screen.getByRole('button', { name: '태그 변경 미리보기' }));
    const next = createBatchSelectionStore();
    rerender(
      <QueryClientProvider client={client}>
        <ActivityBatchTags {...props} store={next} scope={['users', 'bob', 'session']} />
      </QueryClientProvider>,
    );
    expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(store.getState().locked).toBe(false);
    await act(async () => resolve?.(tagResponse(tagActivity())));
    expect(screen.queryByRole('group', { name: '일괄 태그 변경 확인' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '변경할 로컬 태그' })).toHaveValue('');
    expect(next.getState().targets).toHaveLength(0);
  });

  it('renders local tags on cards, table and details separately from immutable measurements', () => {
    const item = tagActivity(['Run', '공백 태그']);
    const { rerender } = render(
      <BrowserRecords items={[item]} view="cards" selected={null} onSelect={() => {}} />,
    );
    expect(screen.getByText('로컬 태그: Run · 공백 태그')).toBeVisible();
    rerender(<BrowserRecords items={[item]} view="table" selected={null} onSelect={() => {}} />);
    expect(screen.getByText('로컬 태그: Run · 공백 태그')).toBeVisible();
    rerender(<BrowserDetail activity={item} />);
    expect(
      within(screen.getByRole('region', { name: '활동 로컬 태그' })).getByText(
        '로컬 태그: Run · 공백 태그',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '원본 기록' })).queryByText(/공백 태그/),
    ).not.toBeInTheDocument();
  });

  it('submits the normalized exact tag filter while preserving selection and other URL keys with GET-only requests', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current')
        ? tagResponse({ head: null, history: [] })
        : tagResponse({ items: [], total: 0, collectionRevision: '0' }),
    );
    let latest = '';
    function Host() {
      const [search, setSearch] = useState('view=table&source=fixture&sort=title_asc&extra=keep');
      return (
        <ActivityBrowser
          athleteId="alice"
          sessionId="session"
          transport={{ request }}
          search={search}
          onSearchChange={(value) => {
            latest = value;
            setSearch(value);
          }}
          initialTimezone="UTC"
          importHref="/import"
        />
      );
    }
    render(<Host />);
    const filter = await screen.findByRole('textbox', { name: '로컬 태그 필터' });
    fireEvent.change(filter, { target: { value: ' e\u0301_% ' } });
    await userEvent.click(screen.getByRole('button', { name: '활동 필터 적용' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) => new URL(input.path, 'http://local').searchParams.get('tag') === 'é_%',
        ),
      ).toBe(true),
    );
    const params = new URLSearchParams(latest);
    expect(params.get('tag')).toBe('é_%');
    expect(params.get('view')).toBe('table');
    expect(params.get('extra')).toBe('keep');
    expect(readActivitySearch(latest).query?.tag).toBe('é_%');
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
