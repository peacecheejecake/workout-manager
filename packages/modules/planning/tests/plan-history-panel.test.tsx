import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { PlanDraft, PlanRead, PlanSnapshot } from '@workout/contracts/planning';
import { PlanHistoryPanel } from '../src/plan-history-panel';
const draft: PlanDraft = {
  title: '봄 시즌',
  timezone: 'Asia/Seoul',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: '시즌',
      startDate: '2026-09-01',
      endDateExclusive: '2026-12-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'wave',
      parentId: 'season',
      level: 'wave',
      title: '웨이브',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'phase',
      parentId: 'wave',
      level: 'phase',
      title: '페이즈',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'block',
      parentId: 'phase',
      level: 'block',
      title: '10일 Block',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-11',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
  ],
  sessions: [
    {
      id: 'session-1',
      blockId: 'block',
      date: '2026-09-09',
      localStartTime: null,
      title: '쉬운 달리기',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '가볍게',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
};

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const before: PlanSnapshot = {
  id: a,
  version: 1,
  createdAt: '2026-09-17T00:00:00Z',
  draft: { ...draft, title: '이전 저장 제목' },
};
const after: PlanSnapshot = {
  id: b,
  version: 2,
  createdAt: '2026-09-17T00:01:00Z',
  draft: { ...draft, title: '이후 저장 제목' },
};
const current: PlanRead = {
  head: after,
  history: [
    { id: b, version: 2, createdAt: after.createdAt, title: after.draft.title },
    { id: a, version: 1, createdAt: before.createdAt, title: before.draft.title },
  ],
};
const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
function setup(request: AuthenticatedTransport['request'], search = '', athleteId = 'alice') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const changed = vi.fn();
  function Host({
    value = current,
    initialSearch = search,
    owner = athleteId,
  }: {
    value?: PlanRead;
    initialSearch?: string;
    owner?: string;
  }) {
    const [query, setQuery] = useState(initialSearch);
    return (
      <PlanHistoryPanel
        athleteId={owner}
        sessionId="session"
        transport={{ request }}
        current={value}
        search={query}
        onSearchChange={(next) => {
          changed(next);
          setQuery(next);
        }}
      />
    );
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
  return { ...view, client, changed, Host };
}
describe('immutable saved plan comparison', () => {
  it('opens explicit fixed IDs, preserves unrelated URL state and does not drift to a newer head', async () => {
    const user = userEvent.setup();
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      reply(input.path.endsWith(a) ? before : after),
    );
    const { rerender, client, Host, changed } = setup(
      request,
      'lens=rolling&plannedSession=session-1',
    );
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '버전 1과 비교' }));
    await screen.findByRole('combobox', { name: '비교할 기간' });
    expect(request).toHaveBeenCalledTimes(2);
    const params = new URLSearchParams(changed.mock.lastCall?.[0]);
    expect(params.get('compareFrom')).toBe(a);
    expect(params.get('compareTo')).toBe(b);
    expect(params.get('plannedSession')).toBe('session-1');
    expect(screen.getByRole('heading', { name: '저장된 계획 버전 비교' })).toHaveFocus();
    const next = { ...current, head: { ...after, id: c, version: 3 } };
    rerender(
      <QueryClientProvider client={client}>
        <Host value={next} />
      </QueryClientProvider>,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('region', { name: '이후 저장 버전' })).toHaveTextContent(b);
    await user.click(screen.getByRole('button', { name: '버전 비교 닫기' }));
    expect(screen.getByRole('button', { name: '버전 1과 비교' })).toHaveFocus();
    const closed = new URLSearchParams(changed.mock.lastCall?.[0]);
    expect(closed.has('compareFrom')).toBe(false);
    expect(closed.get('plannedSession')).toBe('session-1');
  });
  it('does not fetch invalid pairs and supports explicit recovery without destroying the lens', async () => {
    const user = userEvent.setup(),
      request = vi.fn();
    const { changed } = setup(request, 'compareFrom=invalid&compareTo=' + b + '&lens=calendar');
    expect(screen.getByRole('alert')).toHaveTextContent('비교 주소');
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '버전 비교 닫기' }));
    expect(new URLSearchParams(changed.mock.lastCall?.[0]).get('lens')).toBe('calendar');
  });
  it('rejects mismatched snapshot IDs and retries both immutable reads before showing comparison', async () => {
    const user = userEvent.setup();
    let bad = true;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      reply(input.path.endsWith(a) ? before : bad ? { ...after, id: c } : after),
    );
    setup(request, `compareFrom=${a.toUpperCase()}&compareTo=${b}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('두 버전을 확인하지 못했습니다');
    expect(screen.queryByRole('combobox', { name: '비교할 기간' })).not.toBeInTheDocument();
    bad = false;
    await user.click(screen.getByRole('button', { name: '버전 비교 다시 확인' }));
    await screen.findByRole('combobox', { name: '비교할 기간' });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('hides an old comparison while a changed pair is loading and ignores its late response', async () => {
    let finish: (value: ReturnType<typeof reply>) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>((input) =>
      input.path.endsWith(a)
        ? Promise.resolve(reply(before))
        : input.path.endsWith(b)
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(
              reply({
                ...after,
                id: c,
                version: 3,
                draft: { ...draft, title: '세 번째 고정 제목' },
              }),
            ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const change = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <PlanHistoryPanel
          athleteId="alice"
          sessionId="s"
          current={current}
          search={`compareFrom=${a}&compareTo=${b}`}
          onSearchChange={change}
          transport={{ request }}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: '이전 저장 버전' })).not.toBeInTheDocument();
    view.rerender(
      <QueryClientProvider client={client}>
        <PlanHistoryPanel
          athleteId="alice"
          sessionId="s"
          current={current}
          search={`compareFrom=${a}&compareTo=${c}`}
          onSearchChange={change}
          transport={{ request }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText(/세 번째 고정 제목/);
    await act(async () => finish(reply(after)));
    expect(screen.getByRole('region', { name: '이후 저장 버전' })).toHaveTextContent(c);
    expect(screen.getByRole('region', { name: '이후 저장 버전' })).not.toHaveTextContent(
      '이후 저장 제목',
    );
  });
  it('uses separate account cache keys and cannot show the previous account after a late response', async () => {
    let finish: (value: ReturnType<typeof reply>) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender, client, Host } = setup(request, `compareFrom=${a}&compareTo=${a}`);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const oldFinish = finish;
    rerender(
      <QueryClientProvider client={client}>
        <Host owner="bob" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () => oldFinish(reply(before)));
    expect(screen.queryByRole('region', { name: '이전 저장 버전' })).not.toBeInTheDocument();
    expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
  it('offers a past-only period and distinguishes moved sessions, deleted sessions, step order and missing label fields', async () => {
    const user = userEvent.setup();
    const session = draft.sessions[0];
    if (!session) throw new Error('Missing session fixture');
    const steps = [
      {
        id: 'first',
        kind: 'warmup' as const,
        durationSeconds: 0,
        distanceMeters: null,
        repetitions: 1,
      },
      {
        id: 'second',
        kind: 'work' as const,
        durationSeconds: null,
        distanceMeters: 0,
        repetitions: 3,
      },
    ];
    const old = {
      ...before,
      draft: {
        ...draft,
        sessions: [
          { ...session, steps },
          { ...session, id: 'removed', title: '삭제된 세션' },
        ],
      },
    };
    const next = {
      ...after,
      draft: {
        ...draft,
        periods: draft.periods.map((period) =>
          period.id === 'block' ? { ...period, id: 'next-block', title: '새 Block' } : period,
        ),
        sessions: [
          { ...session, blockId: 'next-block', steps: [...steps].reverse(), intensityLabel: null },
        ],
      },
    };
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      reply(input.path.endsWith(a) ? old : next),
    );
    setup(request, `compareFrom=${a}&compareTo=${b}&comparePeriod=block`);
    await screen.findByRole('option', { name: /이전 버전에만 있음/ });
    const moved = screen.getByText('세션 쉬운 달리기 · 변경 · 선택 기간 밖으로 이동');
    await user.click(moved);
    const row = moved.closest('details');
    if (!row) throw new Error('Missing detail row');
    const oldValues = within(row).getByRole('region', { name: '이전 세션' }),
      newValues = within(row).getByRole('region', { name: '이후 세션' });
    expect(within(oldValues).getAllByRole('listitem')[0]).toHaveTextContent(
      '단계 ID first · warmup · 0초 · 미정',
    );
    expect(within(newValues).getAllByRole('listitem')[0]).toHaveTextContent(
      '단계 ID second · work · 미정 · 0m',
    );
    expect(oldValues).toHaveTextContent('강도 라벨 미지정 (이전 형식에 값 없음)');
    expect(newValues).not.toHaveTextContent('강도 라벨 미지정 (이전 형식에 값 없음)');
    expect(screen.getByText('세션 삭제된 세션 · 삭제')).toBeVisible();
  });
  it('shows the missing-version failure instead of a partial or stale comparison', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith(a) ? reply(before) : reply(null, 404),
    );
    setup(request, `compareFrom=${a}&compareTo=${b}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('찾을 수 없거나 접근할 수 없습니다');
    expect(screen.queryByRole('region', { name: '이전 저장 버전' })).not.toBeInTheDocument();
  });
});
