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
import { readPlannerSearch } from '../src/lens';
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
    input.method === 'GET'
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
      request: async () =>
        transportReplySchema.parse(
          reply({ head: { ...snapshot, draft: lockedDraft }, history: [] }),
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
