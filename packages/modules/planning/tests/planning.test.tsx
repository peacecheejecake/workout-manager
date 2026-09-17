import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import type { PlanDraft, PlanSnapshot } from '@workout/contracts/planning';
import { PlanningWorkspace, type PlanningWorkspaceProps } from '../src/planning-workspace';
import { createPlanningDraftStore } from '../src/draft-store';
import { readPlannerSearch, updatePlannerSearch } from '../src/lens';
import { actualRange } from '../src/actual-activities';
import { validationGuidance } from '../src/validation-guidance';

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
const snapshot: PlanSnapshot = {
  id: 'version-1',
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  draft,
};
function reply(body: unknown, status = 200) {
  return { status, body, traceId: null };
}
function host(
  put: (request: TransportRequest) => Promise<unknown> = async () =>
    reply({ ...snapshot, id: 'version-2', version: 2 }),
) {
  const request = vi.fn(async (input: TransportRequest) =>
    input.path.startsWith('/bff/v1/activities?')
      ? reply({ items: [], total: 0 })
      : input.method === 'GET'
        ? reply({
            head: snapshot,
            history: [
              { id: snapshot.id, version: 1, createdAt: snapshot.createdAt, title: draft.title },
            ],
          })
        : put(input),
  );
  return {
    request: async (input: TransportRequest) => transportReplySchema.parse(await request(input)),
    spy: request,
  };
}
function StatefulHost(props: Omit<PlanningWorkspaceProps, 'search' | 'onSearchChange'>) {
  const [search, setSearch] = useState('lens=rolling&date=2026-09-10&days=10');
  return <PlanningWorkspace {...props} search={search} onSearchChange={setSearch} />;
}
const base = {
  athleteId: 'athlete-a',
  sessionId: 'session-a',
  today: '2026-09-10',
  createId: () => 'new-key-123',
};

describe('planning lifetime and manual confirmation', () => {
  it('makes no write while editing or previewing; persists only explicit confirmation', async () => {
    const user = userEvent.setup();
    const transport = host();
    render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    const title = screen.getByRole('textbox', { name: '계획 제목' });
    await user.clear(title);
    await user.type(title, '변경된 계획');
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    expect(transport.spy.mock.calls.filter(([r]) => r.method === 'PUT')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '확인하고 계획 버전 저장' }));
    await screen.findByText('계획 버전 2 저장 완료');
    const request = transport.spy.mock.calls.find(([r]) => r.method === 'PUT')?.[0];
    expect(request).toMatchObject({
      idempotencyKey: 'new-key-123',
      body: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: 'version-1',
        draft: { title: '변경된 계획' },
      },
    });
    expect(request?.body).not.toHaveProperty('idempotencyKey');
  });
  it('preserves draft, focus and ongoing composition across URL view changes', async () => {
    const user = userEvent.setup();
    const transport = host();
    const { rerender } = render(
      <PlanningWorkspace
        {...base}
        transport={transport}
        search="view=split"
        onSearchChange={() => {}}
      />,
    );
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    const notes = screen.getByRole('textbox', { name: '세션 메모' });
    await user.type(notes, '아직 전송 안 함');
    fireEvent.compositionStart(notes);
    rerender(
      <PlanningWorkspace
        {...base}
        transport={transport}
        search="view=stack"
        onSearchChange={() => {}}
      />,
    );
    expect(screen.getByRole('textbox', { name: '세션 메모' })).toBe(notes);
    expect(notes).toHaveFocus();
    expect(notes).toHaveValue('아직 전송 안 함');
    fireEvent.compositionEnd(notes);
    expect(transport.spy.mock.calls.filter(([r]) => r.method === 'PUT')).toHaveLength(0);
  });
  it('keeps the same retry key after an unknown network result', async () => {
    const user = userEvent.setup();
    let writes = 0;
    const transport = host(async () => {
      writes++;
      if (writes === 1) throw new Error('connection interrupted');
      return reply({ ...snapshot, id: 'version-2', version: 2 });
    });
    render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await user.click(screen.getByRole('button', { name: '확인하고 계획 버전 저장' }));
    await screen.findByText(/저장 결과를 확인할 수 없습니다/);
    expect(screen.getByRole('textbox', { name: '계획 제목' })).toHaveValue('봄 시즌');
    await user.click(screen.getByRole('button', { name: '확인하고 계획 버전 저장' }));
    await screen.findByText('계획 버전 2 저장 완료');
    const requests = transport.spy.mock.calls.filter(([r]) => r.method === 'PUT').map(([r]) => r);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  });
  it('retains a stale draft and does not silently retry against a new head', async () => {
    const user = userEvent.setup();
    const transport = host(async () => reply({ error: 'PLAN_STALE' }, 409));
    render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await user.type(screen.getByRole('textbox', { name: '계획 제목' }), ' 초안');
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await user.click(screen.getByRole('button', { name: '확인하고 계획 버전 저장' }));
    await screen.findByText(/다른 변경과 충돌/);
    expect(screen.getByRole('textbox', { name: '계획 제목' })).toHaveValue('봄 시즌 초안');
    expect(screen.getByRole('button', { name: '확인하고 계획 버전 저장' })).toBeDisabled();
    expect(transport.spy.mock.calls.filter(([r]) => r.method === 'PUT')).toHaveLength(1);
  });
  it('drops private draft and cached plan immediately on session replacement', async () => {
    const user = userEvent.setup();
    const transport = host();
    const { rerender } = render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await user.type(screen.getByRole('textbox', { name: '계획 제목' }), ' private');
    const nextTransport: AuthenticatedTransport = { request: () => new Promise(() => {}) };
    rerender(<StatefulHost {...base} sessionId="session-b" transport={nextTransport} />);
    expect(screen.queryByRole('textbox', { name: '계획 제목' })).not.toBeInTheDocument();
    expect(screen.queryByText(/현재 버전:/)).not.toBeInTheDocument();
  });
  it('undoes edits and retains zero versus unknown values in fields and projection', async () => {
    const user = userEvent.setup();
    render(<StatefulHost {...base} transport={host()} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    expect(screen.getByRole('spinbutton', { name: '거리 (m, 미정 가능)' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: '시간 (초, 미정 가능)' })).toHaveValue(null);
    fireEvent.change(screen.getByRole('textbox', { name: '계획 제목' }), {
      target: { value: '다른 제목' },
    });
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(screen.getByRole('textbox', { name: '계획 제목' })).toHaveValue('봄 시즌');
    expect(
      within(screen.getByRole('region', { name: '일별 계획' })).getAllByText(
        /실제 휴식 여부 미확인/,
      ),
    ).toHaveLength(9);
  });
});

describe('idempotent receipt versus authoritative head', () => {
  it('does not expose an old replay receipt while the newer current head is loading', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let finishRead: ((value: ReturnType<typeof transportReplySchema.parse>) => void) | undefined;
    const transport: AuthenticatedTransport = {
      request: async (input) => {
        if (input.path === '/bff/v1/plans/current/session-completions')
          return transportReplySchema.parse(reply({}, 503));
        if (input.path.startsWith('/bff/v1/activities?'))
          return transportReplySchema.parse(reply({ items: [], total: 0 }));
        if (input.method === 'PUT')
          return transportReplySchema.parse(reply({ ...snapshot, id: 'version-2', version: 2 }));
        reads++;
        if (reads === 1) return transportReplySchema.parse(reply({ head: snapshot, history: [] }));
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      },
    };
    render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await user.click(screen.getByRole('button', { name: '확인하고 계획 버전 저장' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByText(/현재 버전:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '계획 초안 편집' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '계획 제목' })).not.toBeInTheDocument();
    await act(async () => {
      finishRead?.(
        transportReplySchema.parse(
          reply({ head: { ...snapshot, id: 'version-3', version: 3 }, history: [] }),
        ),
      );
    });
    expect(await screen.findByText(/현재 버전: 3/)).toBeInTheDocument();
    expect(screen.getByText('계획 버전 2 저장 완료')).toBeInTheDocument();
    expect(screen.queryByText(/현재 버전: 2/)).not.toBeInTheDocument();
  });
  it('keeps only the save receipt on authoritative read failure and blocks a stale edit start', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const transport: AuthenticatedTransport = {
      request: async (input) => {
        if (input.path === '/bff/v1/plans/current/session-completions')
          return transportReplySchema.parse(reply({}, 503));
        if (input.path.startsWith('/bff/v1/activities?'))
          return transportReplySchema.parse(reply({ items: [], total: 0 }));
        if (input.method === 'PUT')
          return transportReplySchema.parse(reply({ ...snapshot, id: 'version-2', version: 2 }));
        reads++;
        return transportReplySchema.parse(
          reads === 1
            ? reply({ head: snapshot, history: [] })
            : reply({ error: 'UNAVAILABLE' }, 503),
        );
      },
    };
    render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await user.click(screen.getByRole('button', { name: '확인하고 계획 버전 저장' }));
    await screen.findByText('계획 버전 2 저장 완료');
    expect(screen.getByText(/계획을 확인할 수 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/현재 버전:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '계획 초안 편집' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '계획 버전 이력' })).queryByRole('listitem'),
    ).not.toBeInTheDocument();
  });
});

describe('plan editor constraints', () => {
  it('creates a hierarchy and session from empty state with explicit preview', async () => {
    const user = userEvent.setup();
    let ids = 0;
    const request = vi.fn(async () =>
      transportReplySchema.parse(reply({ head: null, history: [] })),
    );
    render(
      <StatefulHost {...base} createId={() => `generated-${++ids}`} transport={{ request }} />,
    );
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    expect(screen.getByRole('button', { name: '변경 미리보기' })).toBeDisabled();
    for (const level of ['season', 'wave', 'phase', 'block'])
      await user.click(screen.getByRole('button', { name: `${level} 추가` }));
    await user.click(screen.getByRole('button', { name: '세션 추가' }));
    await user.click(screen.getByRole('button', { name: '단계 추가' }));
    await user.click(screen.getByRole('button', { name: '세션 복제' }));
    expect(screen.getAllByRole('textbox', { name: '세션 제목' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '계획 세션 선택 해제' }));
    expect(screen.getAllByRole('textbox', { name: '세션 제목' })).toHaveLength(2);
    const deleteButtons = screen.getAllByRole('button', { name: '세션 삭제' });
    const duplicateDelete = deleteButtons.at(1);
    if (!duplicateDelete) throw new Error('Expected duplicate action');
    await user.click(duplicateDelete);
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    expect(screen.getByRole('region', { name: '변경 미리보기' })).toHaveTextContent(
      '기간 4개, 계획 세션 1개',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('requires prior saved unlock rather than immediately allowing locked changes', async () => {
    const user = userEvent.setup();
    const lockedDraft = {
      ...draft,
      sessions: draft.sessions.map((session) => ({
        ...session,
        locks: { date: true, time: true, intensity: true },
      })),
    };
    const transport: AuthenticatedTransport = {
      request: async (input) =>
        transportReplySchema.parse(
          input.path.startsWith('/bff/v1/activities?')
            ? reply({ items: [], total: 0 })
            : reply({ head: { ...snapshot, draft: lockedDraft }, history: [] }),
        ),
    };
    render(<StatefulHost {...base} transport={transport} />);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    expect(screen.getByLabelText('세션 날짜')).toBeDisabled();
    expect(screen.getByLabelText('계획 시간대')).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '거리 (m, 미정 가능)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'intensity 잠금' }));
    expect(screen.getByRole('spinbutton', { name: '거리 (m, 미정 가능)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '변경 미리보기' })).toBeEnabled();
  });
  it('reports unknown URL period rather than crashing or selecting an invented period', async () => {
    render(
      <PlanningWorkspace
        {...base}
        transport={host()}
        search="lens=period&period=missing"
        onSearchChange={() => {}}
      />,
    );
    await screen.findByRole('button', { name: '계획 초안 편집' });
    expect(screen.getByRole('alert')).toHaveTextContent('기간을 찾을 수 없습니다');
  });
});

describe('draft store', () => {
  it('validates preview and rotates key only when a new preview is created', () => {
    let key = 0;
    const store = createPlanningDraftStore(() => `key-${++key}`);
    const actions = store.getState().actions;
    actions.start(snapshot, draft);
    expect(actions.preview()).toBe(true);
    const first = store.getState().state.preview;
    actions.preview();
    expect(store.getState().state.preview).toBe(first);
    actions.edit((value) => ({ ...value, title: 'new' }));
    expect(store.getState().state.preview).toBeNull();
    actions.preview();
    expect(store.getState().state.preview?.idempotencyKey).not.toBe(first?.idempotencyKey);
    actions.edit((value) => ({ ...value, title: '' }));
    expect(actions.preview()).toBe(false);
  });
  it('preserves explicit draft when rebasing to a newer version', () => {
    const store = createPlanningDraftStore();
    const actions = store.getState().actions;
    actions.start(snapshot, draft);
    actions.edit((value) => ({ ...value, title: 'my draft' }));
    actions.rebase({ ...snapshot, id: 'version-2', version: 2 });
    expect(store.getState().state.draft?.title).toBe('my draft');
    expect(store.getState().state.baseline?.id).toBe('version-2');
  });
});

describe('bounded URL lenses', () => {
  it('keeps rolling separate from period tree and rejects oversized/invalid ranges', () => {
    expect(readPlannerSearch('lens=rolling&days=10&date=2026-09-10', '2026-09-10').lens).toEqual({
      kind: 'rolling',
      anchorDate: '2026-09-10',
      days: 10,
    });
    expect(readPlannerSearch('days=367', '2026-09-10').error).toBe(true);
    expect(
      readPlannerSearch('lens=calendar&from=2026-01-01&to=2028-01-01', '2026-09-10').error,
    ).toBe(true);
    expect(readPlannerSearch('date=invalid', '2026-09-10').error).toBe(true);
  });
});

describe('editing guidance', () => {
  it('explains an empty period tree without exposing parser details', () => {
    expect(
      validationGuidance({
        code: 'too_small',
        path: ['periods'],
        minimum: 1,
        message: 'Too small: expected array to have >=1 items',
      }),
    ).toBe('기간: Season을 추가한 뒤 필요한 Wave·Phase·Block을 구성하세요.');
  });
  it('identifies the affected period and explains its parent range', () => {
    expect(
      validationGuidance({
        code: 'custom',
        path: ['periods', 2],
        message: 'Period exceeds parent range',
      }),
    ).toBe('기간 3: 시작일과 종료일을 상위 기간 안에 배치하세요.');
  });
  it('does not leak unrecognized schema messages in the fallback', () => {
    const guidance = validationGuidance({
      code: 'unknown',
      path: ['sessions', 0, 'notes'],
      message: 'INTERNAL_SCHEMA_DETAIL',
    });
    expect(guidance).toContain('세션 1 · 메모');
    expect(guidance).not.toContain('INTERNAL_SCHEMA_DETAIL');
  });
});

describe('saved-plan actual activity range', () => {
  it('bounds SQL dates and rejects absent or draft-only periods; view changes retain pages', () => {
    expect(actualRange(snapshot, { kind: 'period', periodId: 'draft-only' }, false)).toBeNull();
    expect(
      actualRange(null, { kind: 'rolling', anchorDate: '2026-09-10', days: 10 }, false),
    ).toBeNull();
    expect(
      actualRange(
        snapshot,
        { kind: 'calendar', from: '0000-01-01', toExclusive: '0000-01-02' },
        false,
      ),
    ).toBeNull();
    expect(
      actualRange(snapshot, { kind: 'rolling', anchorDate: '9999-12-31', days: 10 }, false),
    ).toBeNull();
    expect(actualRange(snapshot, { kind: 'period', periodId: 'block' }, false)?.timezone).toBe(
      'Asia/Seoul',
    );
    expect(
      new URLSearchParams(updatePlannerSearch('actualPage=3', { view: 'split' })).get('actualPage'),
    ).toBe('3');
    expect(
      new URLSearchParams(updatePlannerSearch('actualPage=3', { days: '7' })).has('actualPage'),
    ).toBe(false);
  });
  it('keeps the saved timezone and draft through actual refresh, pagination and errors', async () => {
    let failed = false;
    const activity = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
      source: { kind: 'manual', sourceId: 'manual', revision: 1, contentHash: 'a'.repeat(64) },
      original: {
        title: '실제 기록',
        kind: 'running',
        startedAt: '2026-09-09T23:00:00Z',
        timezone: 'UTC',
        durationSeconds: null,
        durationKind: 'unknown',
        distanceMeters: 0,
      },
      overlay: {},
    };
    const request = vi.fn(async (input: TransportRequest) => {
      if (input.path.startsWith('/bff/v1/activities?'))
        return transportReplySchema.parse(
          failed
            ? reply(null, 503)
            : reply({ items: [{ ...activity, effective: activity.original }], total: 51 }),
        );
      return transportReplySchema.parse(reply({ head: snapshot, history: [] }));
    });
    const { rerender } = render(
      <StatefulHost
        {...base}
        transport={{ request }}
        activityHref={(id) => `/activities?selected=${id}`}
      />,
    );
    const region = await screen.findByRole('region', { name: '실제 활동 레이어' });
    await within(region).findByText('실제 기록');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '계획 초안 편집' }));
    fireEvent.change(screen.getByLabelText('계획 제목'), { target: { value: '보존 초안' } });
    fireEvent.change(screen.getByLabelText('계획 시간대'), {
      target: { value: 'America/New_York' },
    });
    await user.click(within(region).getByRole('button', { name: '다음 실제 활동' }));
    await within(region).findByText(/2페이지/);
    expect(screen.getByLabelText('계획 제목')).toHaveValue('보존 초안');
    const actualRequests = request.mock.calls.filter(([input]) =>
      input.path.startsWith('/bff/v1/activities?'),
    );
    expect(
      actualRequests.every(
        ([input]) =>
          new URL(input.path, 'http://local').searchParams.get('timezone') === 'Asia/Seoul',
      ),
    ).toBe(true);
    expect(actualRequests.at(-1)?.[0].path).toContain('offset=50');
    expect(
      within(region).getByRole('link', { name: '실제 활동 상세 보기 (새 탭)' }),
    ).toHaveAttribute('target', '_blank');
    failed = true;
    await user.click(within(region).getByRole('button', { name: '실제 활동 다시 확인' }));
    await within(region).findByText(/아래는 마지막 조회 결과/);
    expect(within(region).getByText('실제 기록')).toBeVisible();
    expect(screen.getByLabelText('계획 제목')).toHaveValue('보존 초안');
    fireEvent.change(screen.getByLabelText('Rolling 기준일'), { target: { value: '2026-09-11' } });
    await within(region).findByText(/실제 활동 최신 확인 실패/);
    expect(within(region).queryByText('실제 기록')).not.toBeInTheDocument();
    expect(screen.getByLabelText('계획 제목')).toHaveValue('보존 초안');
    failed = false;
    await user.click(within(region).getByRole('button', { name: '실제 활동 다시 확인' }));
    await within(region).findByText('실제 기록');
    rerender(
      <StatefulHost
        {...base}
        athleteId="other-athlete"
        sessionId="other-session"
        transport={{ request: async () => new Promise(() => {}) }}
      />,
    );
    expect(screen.queryByText('실제 기록')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('계획 제목')).not.toBeInTheDocument();
  });
  it('uses a visible page-one fallback for invalid page and performs no fetch without saved head', async () => {
    const transport = host();
    const { rerender } = render(
      <PlanningWorkspace
        {...base}
        transport={transport}
        search="actualPage=999"
        onSearchChange={() => {}}
      />,
    );
    await screen.findByText(/실제 활동 페이지가 올바르지 않아/);
    await waitFor(() =>
      expect(
        transport.spy.mock.calls.some(([input]) => input.path.startsWith('/bff/v1/activities?')),
      ).toBe(true),
    );
    expect(
      transport.spy.mock.calls
        .filter(([input]) => input.path.startsWith('/bff/v1/activities?'))
        .every(([input]) => input.path.includes('offset=0')),
    ).toBe(true);
    const request = vi.fn(async () =>
      transportReplySchema.parse(reply({ head: null, history: [] })),
    );
    rerender(
      <PlanningWorkspace
        {...base}
        sessionId="new-session"
        transport={{ request }}
        search="actualPage=1"
        onSearchChange={() => {}}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/현재 버전:/)).not.toBeInTheDocument());
    expect(request.mock.calls).toHaveLength(1);
  });
});

describe('shared planned-session views', () => {
  it('keeps literal selection and layout URLs independent of the requested renderer', () => {
    const state = readPlannerSearch(
      'view=split&plannedView=table&plannedSession=session-1',
      '2026-09-10',
    );
    expect(state.plannedSession).toBe('session-1');
    expect(state.plannedView).toBe('table');
    expect(state.view).toBe('split');
    expect(
      readPlannerSearch('plannedSession=%20bad&plannedView=unknown', '2026-09-10').selectionError,
    ).toBe(true);
  });
  it('shares calendar/table selection and shows date edits immediately without writing; undo restores the date', async () => {
    const transport = host();
    render(<StatefulHost {...base} transport={transport} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '계획: 쉬운 달리기' }));
    expect(screen.getByRole('region', { name: '선택한 계획 세션' })).toHaveTextContent(
      '저장된 계획',
    );
    await user.click(screen.getByRole('button', { name: '계획 달력 보기' }));
    expect(screen.getByRole('button', { name: '계획: 쉬운 달리기' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '계획 초안 편집' }));
    const date = screen.getByLabelText('세션 날짜');
    fireEvent.change(date, { target: { value: '2026-09-10' } });
    await user.click(screen.getByRole('button', { name: '계획 표 보기' }));
    expect(screen.getByLabelText('세션 날짜')).toBe(date);
    const table = screen.getByRole('table', { name: '계획 세션 표' });
    const selected = within(table)
      .getAllByRole('row')
      .find((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveTextContent('2026-09-10');
    expect(screen.getByRole('region', { name: '선택한 계획 세션' })).toHaveTextContent(
      '미저장 초안',
    );
    expect(transport.spy.mock.calls.some(([input]) => input.method === 'PUT')).toBe(false);
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(screen.getByLabelText('세션 날짜')).toHaveValue('2026-09-09');
    expect(selected).toHaveTextContent('2026-09-09');
  });
  it('keeps out-of-range selection and never substitutes saved views for an invalid draft', async () => {
    render(<StatefulHost {...base} transport={host()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '계획: 쉬운 달리기' }));
    fireEvent.change(screen.getByLabelText('Rolling 기준일'), { target: { value: '2026-09-25' } });
    expect(screen.getByRole('region', { name: '선택한 계획 세션' })).toHaveTextContent(
      '현재 조회 범위 밖',
    );
    await user.click(screen.getByRole('button', { name: '계획 초안 편집' }));
    fireEvent.change(screen.getByLabelText('세션 날짜'), { target: { value: '2026-12-25' } });
    expect(screen.getByText(/초안이 유효하지 않아 날짜별 보기를 표시할 수 없습니다/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '계획: 쉬운 달리기' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '선택한 계획 세션' })).toHaveTextContent(
      '2026-12-25',
    );
    expect(screen.getByRole('button', { name: '변경 미리보기' })).toBeDisabled();
  });
});

it('clears selected session while preserving lens, view, and actual page URL state', async () => {
  const search =
    'lens=period&period=block&view=split&plannedView=table&plannedSession=session-1&actualPage=2';
  const changed = vi.fn();
  render(
    <PlanningWorkspace {...base} transport={host()} search={search} onSearchChange={changed} />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '계획 세션 선택 해제' }));
  const next = new URLSearchParams(String(changed.mock.lastCall?.[0]));
  expect(next.has('plannedSession')).toBe(false);
  expect(next.get('view')).toBe('split');
  expect(next.get('plannedView')).toBe('table');
  expect(next.get('actualPage')).toBe('2');
  expect(next.get('period')).toBe('block');
});
