import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { planReadSchema, type PlanRead } from '@workout/contracts/planning';
import {
  PlanningPeriodNavigator,
  type PlanningPeriodNavigatorProps,
} from '../src/planning-period-navigator';

const saved = planReadSchema.parse({
  head: {
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    createdAt: '2026-09-01T00:00:00Z',
    draft: {
      title: '합성 저장 계획',
      timezone: 'UTC',
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: `합성 ${level}`,
        startDate: '2026-09-01',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [],
    },
  },
  history: [],
});
function reply(body: unknown, status = 200) {
  return transportReplySchema.parse({ status, body, traceId: 'synthetic' });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  request: AuthenticatedTransport['request'],
  overrides: Partial<PlanningPeriodNavigatorProps> = {},
) {
  const search = 'anchor=2026-09-17&window=10&timezone=UTC&custom=a%2Fb';
  const onSearchChange = vi.fn<(query: string) => void>();
  const onCalendar = vi.fn();
  const props: PlanningPeriodNavigatorProps = {
    athleteId: 'alice',
    sessionId: 'alice-session',
    transport: { request },
    search,
    onSearchChange,
    onCalendar,
    planHref: (id) =>
      id === null ? '/planner' : `/planner?lens=period&period=${encodeURIComponent(id)}`,
    ...overrides,
  };
  const view = (patch: Partial<PlanningPeriodNavigatorProps> = {}) => (
    <PlanningPeriodNavigator {...props} {...patch} />
  );
  return { ...render(view()), view, props, onSearchChange, onCalendar };
}
const selected = () => screen.getByRole('region', { name: '현재 선택한 기간' });

describe('dashboard planning period navigator', () => {
  it('reads saved periods independently and preserves unrelated URL state across list, timeline and controlled browser history', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(reply(saved));
    const app = setup(request);
    const user = userEvent.setup();
    await screen.findByText('저장 버전 1 · 합성 저장 계획');
    expect(screen.getByRole('link', { name: '선택한 기간 계획 열기' })).toHaveAttribute(
      'href',
      '/planner',
    );
    await user.click(screen.getByRole('button', { name: 'season · 합성 season' }));
    const seasonSearch = app.onSearchChange.mock.calls.at(-1)?.[0];
    if (!seasonSearch) throw new Error('Expected selected period URL');
    const params = new URLSearchParams(seasonSearch);
    expect(Object.fromEntries(params)).toEqual({
      anchor: '2026-09-17',
      window: '10',
      timezone: 'UTC',
      custom: 'a/b',
      planPeriod: 'season',
    });
    app.rerender(app.view({ search: seasonSearch }));
    expect(within(selected()).getByRole('heading')).toHaveTextContent('합성 season');
    await user.click(screen.getByRole('button', { name: '기간 타임라인 보기' }));
    const timelineSearch = app.onSearchChange.mock.calls.at(-1)?.[0];
    if (!timelineSearch) throw new Error('Expected timeline URL');
    expect(new URLSearchParams(timelineSearch).get('planPeriodView')).toBe('timeline');
    expect(new URLSearchParams(timelineSearch).get('planPeriod')).toBe('season');
    app.rerender(app.view({ search: timelineSearch }));
    expect(screen.getByRole('region', { name: '기간 날짜 길이 타임라인' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '기간 타임라인: wave · 합성 wave' }));
    const waveSearch = app.onSearchChange.mock.calls.at(-1)?.[0];
    if (!waveSearch) throw new Error('Expected child URL');
    app.rerender(app.view({ search: waveSearch }));
    expect(screen.getByRole('link', { name: '선택한 기간 계획 열기' })).toHaveAttribute(
      'href',
      '/planner?lens=period&period=wave',
    );
    await user.click(screen.getByRole('button', { name: '이 기간 달력 보기' }));
    expect(app.onCalendar).toHaveBeenCalledWith(
      saved.head?.draft.periods.find((period) => period.id === 'wave'),
    );
    app.rerender(app.view({ search: timelineSearch }));
    expect(within(selected()).getByRole('heading')).toHaveTextContent('합성 season');
    app.rerender(app.view({ search: app.props.search }));
    expect(within(selected()).getByRole('heading')).toHaveTextContent('합성 저장 계획');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/bff/v1/plans/current',
        body: null,
        idempotencyKey: null,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('previews hover/focus without changing the URL and recovers unknown selection/view explicitly', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(reply(saved));
    const app = setup(request, {
      search: 'window=14&planPeriod=missing&planPeriodView=unsupported',
    });
    const user = userEvent.setup();
    await screen.findByText(
      'URL이 가리키는 기간을 찾을 수 없습니다. 전체 계획에서 다시 선택하세요.',
    );
    expect(screen.queryByRole('link', { name: '선택한 기간 계획 열기' })).not.toBeInTheDocument();
    expect(app.onSearchChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '전체 계획 보기' }));
    const rootSearch = app.onSearchChange.mock.calls.at(-1)?.[0];
    if (!rootSearch) throw new Error('Expected root recovery URL');
    expect(new URLSearchParams(rootSearch).has('planPeriod')).toBe(false);
    expect(new URLSearchParams(rootSearch).get('window')).toBe('14');
    app.rerender(app.view({ search: rootSearch }));
    expect(screen.getByRole('button', { name: '기간 원형 보기' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '기간 원형 보기로 복구' }));
    const recovered = app.onSearchChange.mock.calls.at(-1)?.[0];
    if (!recovered) throw new Error('Expected view recovery URL');
    app.rerender(app.view({ search: recovered }));
    expect(screen.queryByText(/기간 보기 값이 유효하지 않아/)).not.toBeInTheDocument();
    app.onSearchChange.mockClear();
    const period = screen.getByRole('button', { name: 'season · 합성 season' });
    fireEvent.mouseEnter(period);
    act(() => period.focus());
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toBeVisible();
    expect(app.onSearchChange).not.toHaveBeenCalled();
    const orbit = await screen.findByRole('button', { name: '기간 원형: season · 합성 season' });
    act(() => orbit.focus());
    await user.keyboard('{Enter}');
    expect(new URLSearchParams(app.onSearchChange.mock.calls.at(-1)?.[0]).get('planPeriod')).toBe(
      'season',
    );
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('shows loading, empty and initial failure honestly and retries without manufacturing a plan', async () => {
    const pending = deferred<ReturnType<typeof reply>>();
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(reply({ head: null, history: [] } satisfies PlanRead));
    setup(request);
    const user = userEvent.setup();
    expect(screen.getByText('저장된 계획 기간을 확인하고 있습니다.')).toBeVisible();
    expect(screen.getByRole('button', { name: '계획 기간 다시 확인' })).toBeDisabled();
    await act(async () => pending.resolve(reply({ code: 'UNAVAILABLE' }, 503)));
    await screen.findByText('계획 기간을 확인하지 못했습니다. 다시 확인해 주세요.');
    expect(screen.queryByRole('region', { name: '기간 탐색' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '계획 기간 다시 확인' }));
    await screen.findByText('저장된 계획이 없습니다. 계획 화면에서 기간을 작성하고 저장해 주세요.');
    expect(screen.queryByRole('link', { name: '선택한 기간 계획 열기' })).not.toBeInTheDocument();
  });

  it('labels retained cached data as stale after refetch failure and recovers with a new saved version', async () => {
    if (!saved.head) throw new Error('Expected saved head');
    const updated = {
      ...saved,
      head: { ...saved.head, version: 2, draft: { ...saved.head.draft, title: '새 저장 계획' } },
    };
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce(reply(saved))
      .mockResolvedValueOnce(reply({ code: 'UNAVAILABLE' }, 503))
      .mockResolvedValue(reply(updated));
    const app = setup(request, { search: 'planPeriod=phase&planPeriodView=timeline' });
    const user = userEvent.setup();
    await screen.findByText('저장 버전 1 · 합성 저장 계획');
    const observedAt = screen.getByText(/계획 조회 시각/).querySelector('time')?.dateTime;
    expect(observedAt).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '계획 기간 다시 확인' }));
    await screen.findByText(
      '최신 계획 확인에 실패했습니다. 아래는 마지막으로 확인한 저장 계획입니다.',
    );
    expect(screen.getByText('저장 버전 1 · 합성 저장 계획')).toBeVisible();
    expect(screen.getByText(/계획 조회 시각/).querySelector('time')?.dateTime).toBe(observedAt);
    expect(within(selected()).getByRole('heading')).toHaveTextContent('합성 phase');
    expect(app.onSearchChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '계획 기간 다시 확인' }));
    await screen.findByText('저장 버전 2 · 새 저장 계획');
    expect(screen.queryByText(/최신 계획 확인에 실패했습니다/)).not.toBeInTheDocument();
    expect(within(selected()).getByRole('heading')).toHaveTextContent('합성 phase');
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it.each(['account', 'session'] as const)(
    'aborts an old %s request and isolates late private data without retaining the previous cache',
    async (boundary) => {
      const old = deferred<ReturnType<typeof reply>>();
      const request = vi
        .fn<AuthenticatedTransport['request']>()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(reply({ head: null, history: [] }));
      const app = setup(request);
      const signal = request.mock.calls[0]?.[0].signal;
      app.rerender(
        app.view(
          boundary === 'account'
            ? { athleteId: 'bob', sessionId: 'bob-session' }
            : { sessionId: 'new-alice-session' },
        ),
      );
      expect(signal?.aborted).toBe(true);
      await screen.findByText(
        '저장된 계획이 없습니다. 계획 화면에서 기간을 작성하고 저장해 주세요.',
      );
      await act(async () => old.resolve(reply(saved)));
      expect(screen.queryByText('저장 버전 1 · 합성 저장 계획')).not.toBeInTheDocument();
      app.rerender(app.view());
      await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      expect(screen.queryByText('저장 버전 1 · 합성 저장 계획')).not.toBeInTheDocument();
    },
  );

  it('cancels on unmount and rejects malformed plan responses at the public boundary', async () => {
    const pending = deferred<ReturnType<typeof reply>>();
    const request = vi.fn<AuthenticatedTransport['request']>().mockReturnValue(pending.promise);
    const app = setup(request);
    const signal = request.mock.calls[0]?.[0].signal;
    app.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(reply(saved)));
    expect(screen.queryByRole('region', { name: '대시보드 기간 탐색' })).not.toBeInTheDocument();
    setup(
      vi
        .fn<AuthenticatedTransport['request']>()
        .mockResolvedValue(reply({ head: { version: 1 }, history: [] })),
    );
    await screen.findByText('계획 기간을 확인하지 못했습니다. 다시 확인해 주세요.');
  });
});
