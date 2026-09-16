import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import type { Activity } from '@workout/contracts/activity';
import { ActivityBrowser, type ActivityBrowserProps } from '../src/activity-browser';
import { readActivitySearch } from '../src/browser-search';

type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const values = {
  title: '관측된 영',
  kind: 'running' as const,
  startedAt: null,
  timezone: null,
  durationSeconds: 0,
  durationKind: 'timer' as const,
  distanceMeters: 0,
};
const activity: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source: { kind: 'fit', sourceId: 'source-one', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};
const missing: Activity = {
  ...activity,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  effective: {
    ...values,
    title: '미확인 활동',
    distanceMeters: null,
    durationSeconds: null,
    durationKind: 'unknown',
  },
};
const reply = (body: unknown, status = 200): Reply => ({
  status,
  body: z.json().parse(body),
  traceId: null,
});
const list = () => reply({ items: [activity, missing], total: 2 });
function setup(
  handler: (input: TransportRequest) => Promise<Reply> = async (input) =>
    input.path.includes('?') ? list() : reply(activity),
  search = '',
) {
  const request = vi.fn(handler);
  const changed = vi.fn();
  const props: ActivityBrowserProps = {
    athleteId: 'alice',
    sessionId: 'session-a',
    transport: { request },
    search,
    onSearchChange: changed,
    initialTimezone: 'Asia/Seoul',
    importHref: '/activities/import',
  };
  function Host({ value }: { value: ActivityBrowserProps }) {
    const [query, setQuery] = useState(value.search);
    return (
      <ActivityBrowser
        {...value}
        search={query}
        onSearchChange={(next) => {
          changed(next);
          setQuery(next);
        }}
      />
    );
  }
  return {
    ...render(<Host value={props} />),
    request,
    changed,
    props,
    tree: (value: ActivityBrowserProps) => <Host value={value} />,
  };
}
describe('read-only activity browser', () => {
  it('rejects invalid supported URL values without fetching', () => {
    const { request } = setup(undefined, 'from=2026-03-01&view=invalid');
    expect(screen.getByRole('alert')).toHaveTextContent('조회 주소');
    expect(request).not.toHaveBeenCalled();
    for (const search of [
      'sort=bad',
      'selected=bad',
      'source=garmin',
      'offset=10001',
      'from=2026-01-01&toExclusive=2026-01-02',
    ])
      expect(readActivitySearch(search).invalid).toBe(true);
  });
  it('recovers an invalid selection URL with explicit reset', async () => {
    const { changed } = setup(undefined, 'selected=invalid&view=bad');
    await userEvent.click(screen.getByRole('button', { name: '활동 조회 조건 초기화' }));
    await screen.findByRole('button', { name: '관측된 영' });
    expect(changed.mock.lastCall?.[0]).toBe('');
  });
  it('distinguishes an empty page from an empty filtered collection', async () => {
    setup(async () => reply({ items: [], total: 1 }), 'offset=20');
    await screen.findByText(
      '이 페이지에 활동이 없습니다. 이전 페이지로 이동하거나 조회 조건을 다시 적용하세요.',
    );
    expect(screen.queryByText('조회 조건에 맞는 활동이 없습니다.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이전 활동' })).toBeEnabled();
  });
  it('renders filtered totals, zero and unknown consistently across cards and table without a global summary', async () => {
    const { request } = setup();
    await screen.findByText('조회 조건에 맞는 활동 2개 · 현재 페이지 2개');
    expect(screen.getByText('0m · 0초 · 타이머 시간 (timer)')).toBeVisible();
    expect(
      screen.getByText('거리 미확인 · 시간 미확인 · 정의 미확인 시간 (unknown)'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '표 보기' }));
    const table = await screen.findByRole('table', { name: '조회 조건에 맞는 활동' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('0m');
    expect(rows[2]).toHaveTextContent('거리 미확인');
    expect(
      request.mock.calls.every(
        ([input]) => input.method === 'GET' && !input.path.endsWith('/summary'),
      ),
    ).toBe(true);
    expect(screen.getByRole('link', { name: 'FIT 가져오기·정정' })).toHaveAttribute(
      'href',
      '/activities/import',
    );
  });
  it('loads selection independently of pages and preserves it through filters, paging and view changes', async () => {
    const { changed, request } = setup(
      async (input) =>
        input.path.includes('?') ? reply({ items: [missing], total: 21 }) : reply(activity),
      `selected=${activity.id}`,
    );
    const detail = await screen.findByRole('region', { name: '선택한 활동 상세' });
    expect(await within(detail).findByRole('region', { name: '정정 반영 기록' })).toHaveTextContent(
      '관측된 영',
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '다음 활동' }));
    await user.click(screen.getByRole('button', { name: '표 보기' }));
    await user.selectOptions(screen.getByLabelText('종목 필터'), 'cycling');
    await user.click(screen.getByRole('button', { name: '활동 필터 적용' }));
    const finalSearch = new URLSearchParams(String(changed.mock.lastCall?.[0]));
    expect(finalSearch.get('selected')).toBe(activity.id);
    expect(finalSearch.get('view')).toBe('table');
    expect(finalSearch.get('kind')).toBe('cycling');
    expect(finalSearch.has('offset')).toBe(false);
    expect(within(detail).getByRole('region', { name: '정정 반영 기록' })).toHaveTextContent(
      '관측된 영',
    );
    expect(
      request.mock.calls.some(([input]) => input.path === `/bff/v1/activities/${activity.id}`),
    ).toBe(true);
  });
  it('preserves same-query results with stale notice but hides details after a 404 reread', async () => {
    let fail = false;
    setup(
      async (input) =>
        input.path.includes('?')
          ? fail
            ? reply(null, 503)
            : list()
          : fail
            ? reply(null, 404)
            : reply(activity),
      `selected=${activity.id}`,
    );
    await screen.findByRole('region', { name: '정정 반영 기록' });
    fail = true;
    await userEvent.click(screen.getByRole('button', { name: '활동 목록 다시 확인' }));
    await screen.findByText(/아래는 마지막 조회 결과/);
    expect(screen.getByRole('button', { name: '관측된 영' })).toBeVisible();
    expect(screen.getByText(/마지막 목록 조회 시각/)).toHaveTextContent(
      '공급자 동기화 시각이 아닙니다',
    );
    await userEvent.click(screen.getByRole('button', { name: '활동 상세 다시 확인' }));
    await screen.findByText('기록이 삭제되었거나 접근할 수 없습니다.');
    expect(screen.queryByRole('region', { name: '정정 반영 기록' })).not.toBeInTheDocument();
  });
  it('does not apply filters on IME Enter and clears the complete date condition', async () => {
    const { changed } = setup(
      undefined,
      'from=2026-03-01&toExclusive=2026-03-02&timezone=Asia%2FSeoul',
    );
    const input = screen.getByLabelText('활동 제목 검색');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '달리기' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    const form = input.closest('form');
    if (form) fireEvent.submit(form);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await userEvent.click(screen.getByRole('button', { name: '날짜 조건 지우기' }));
    const query = new URLSearchParams(String(changed.mock.lastCall?.[0]));
    expect(['from', 'toExclusive', 'timezone'].some((key) => query.has(key))).toBe(false);
  });
  it('supports keyboard table scrolling while preserving focus', async () => {
    setup(undefined, 'view=table');
    const region = await screen.findByRole('region', { name: '활동 표 가로 탐색' });
    const scroll = vi.fn();
    Object.defineProperty(region, 'scrollBy', { value: scroll });
    const button = screen.getByRole('button', { name: '활동 표 오른쪽으로 이동' });
    expect(button).toHaveAttribute('aria-controls', region.id);
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(scroll).toHaveBeenCalledWith({ left: 240, behavior: 'auto' });
    expect(button).toHaveFocus();
  });
  it('does not display the previous filter results while a new request is unresolved', async () => {
    let finish: ((value: Reply) => void) | undefined;
    setup(async (input) =>
      input.path.includes('kind=cycling')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : list(),
    );
    await screen.findByRole('button', { name: '관측된 영' });
    await userEvent.selectOptions(screen.getByLabelText('종목 필터'), 'cycling');
    await userEvent.click(screen.getByRole('button', { name: '활동 필터 적용' }));
    expect(screen.queryByRole('button', { name: '관측된 영' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('조회 조건에 맞는 활동 2개 · 현재 페이지 2개'),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish?.(reply({ items: [], total: 0 }));
    });
    await screen.findByText('조회 조건에 맞는 활동이 없습니다.');
  });
  it('ignores late responses from a previous account', async () => {
    let finish: ((value: Reply) => void) | undefined;
    const { props, rerender, tree } = setup(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    rerender(
      tree({
        ...props,
        athleteId: 'bob',
        sessionId: 'session-b',
        transport: { request: async () => reply({ items: [missing], total: 1 }) },
      }),
    );
    await screen.findByRole('button', { name: '미확인 활동' });
    await act(async () => {
      finish?.(list());
    });
    expect(screen.queryByRole('button', { name: '관측된 영' })).not.toBeInTheDocument();
  });
});
