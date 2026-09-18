import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { useStore } from 'zustand';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { planDraftSchema, type PlanSnapshot } from '@workout/contracts/planning';
import { planScenarioSaveSchema, type PlanScenario } from '@workout/contracts/plan-scenarios';
import { PlanScenarioPanel } from '../src/scenario-panel';
import { ScenarioComparison } from '../src/scenario-comparison';
import { createScenarioDraftStore } from '../src/scenario-draft-store';
const baseId = '11111111-1111-4111-8111-111111111111';
const scenarioId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
function base(): PlanSnapshot {
  return {
    id: baseId,
    version: 1,
    createdAt: '2026-09-17T00:00:00Z',
    draft: planDraftSchema.parse({
      title: '합성 기준 계획',
      timezone: 'UTC',
      periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
        id: level,
        parentId: index ? levels[index - 1] : null,
        level,
        title: level,
        startDate: '2080-01-01',
        endDateExclusive: '2080-02-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'run',
          blockId: 'block',
          date: '2080-01-05',
          localStartTime: null,
          title: '합성 세션',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: 0,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    }),
  };
}
function alternative(): PlanScenario {
  return {
    id: scenarioId,
    basePlanVersionId: baseId,
    label: 'A',
    revision: 1,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    draft: base().draft,
  };
}
const response = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
function summary(value: PlanScenario) {
  const { draft, ...metadata } = value;
  return { ...metadata, title: draft.title };
}
function setup(
  options: {
    manual?: boolean;
    existing?: boolean;
    override?: AuthenticatedTransport['request'];
    listPage?: (
      offset: number,
      saved: PlanScenario | null,
    ) => {
      items: ReturnType<typeof summary>[];
      total: number;
    };
  } = {},
) {
  const store = createScenarioDraftStore();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let saved: PlanScenario | null = options.existing === false ? null : alternative();
  const writes = vi.fn(),
    onApplied = vi.fn(async () => {});
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    if (options.override) return options.override(input);
    if (input.method !== 'GET') writes(input);
    if (input.path === '/bff/v1/plans/current') return response({ head: base(), history: [] });
    if (input.path.endsWith('/session-completions'))
      return response({ currentPlanVersionId: baseId, collectionRevision: 0, items: [] });
    if (input.path.includes('/plans/versions/')) return response(base());
    if (input.path.startsWith('/bff/v1/plan-scenarios?')) {
      const offset = Number(
        new URL(input.path, 'https://workout.example').searchParams.get('offset'),
      );
      return response(
        options.listPage?.(offset, saved) ?? {
          items: saved ? [summary(saved)] : [],
          total: saved ? 1 : 0,
        },
      );
    }
    if (input.method === 'POST' && input.path === '/bff/v1/plan-scenarios') {
      saved = alternative();
      return response(saved, 201);
    }
    if (input.method === 'PUT') {
      if (typeof input.body !== 'object' || input.body === null || Array.isArray(input.body))
        throw new Error('Expected scenario command object');
      const command = planScenarioSaveSchema.parse({
        ...input.body,
        idempotencyKey: input.idempotencyKey,
      });
      saved = { ...alternative(), revision: 2, draft: command.draft };
      return response(saved);
    }
    if (input.path.endsWith('/apply'))
      return response({
        plan: { ...base(), id: secondId, version: 2, draft: saved?.draft },
        scenarioId,
        scenarioRevision: saved?.revision,
      });
    return saved ? response(saved) : response(null, 404);
  });
  function Host() {
    const [search, setSearch] = useState(
      `scenarioBase=${baseId}${options.existing === false ? '' : `&scenario=${scenarioId}`}`,
    );
    const busy = useStore(store, (value) => value.draft !== null || value.phase !== 'idle');
    return (
      <QueryClientProvider client={client}>
        <button disabled={busy}>현재 계획 편집 대조</button>
        <PlanScenarioPanel
          athleteId="alice"
          sessionId="auth"
          transport={{ request }}
          current={{ head: base(), history: [] }}
          search={search}
          onSearchChange={setSearch}
          manualDraftActive={options.manual ?? false}
          store={store}
          onApplied={onApplied}
          today="2080-01-01"
          createId={() => 'stable-scenario-key'}
        />
      </QueryClientProvider>
    );
  }
  const view = render(<Host />);
  return { ...view, store, client, request, writes, onApplied };
}

describe('scenario panel independent approval workflows', () => {
  it('creates a fixed-base alternative only after confirmation and returns focus on review cancel', async () => {
    const f = setup({ existing: false });
    const opener = await screen.findByRole('button', { name: '시나리오 A 만들기' });
    await waitFor(() => expect(opener).toBeEnabled());
    await userEvent.click(opener);
    expect(screen.getByRole('button', { name: '시나리오 검토 취소' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '현재 계획 편집 대조' })).toBeDisabled();
    expect(f.writes).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '시나리오 검토 취소' }));
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 만들기' }));
    await screen.findByRole('heading', { name: '시나리오 A · 수정 1' });
    expect(f.writes).toHaveBeenCalledOnce();
    expect(f.writes.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/bff/v1/plan-scenarios',
      idempotencyKey: 'stable-scenario-key',
      body: { confirmed: true, basePlanVersionId: baseId, label: 'A' },
    });
    expect(f.onApplied).not.toHaveBeenCalled();
  });
  it('creates a user-named alternative outside the A/B/C examples', async () => {
    const f = setup({ existing: false });
    const input = await screen.findByRole('textbox', { name: '새 시나리오 이름' });
    const create = screen.getByRole('button', { name: '이름으로 시나리오 만들기' });
    expect(create).toBeDisabled();
    await userEvent.type(input, '대회 준비 주간');
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 만들기' }));
    expect(f.writes.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      body: { confirmed: true, basePlanVersionId: baseId, label: '대회 준비 주간' },
    });
  });
  it('pages through alternatives beyond the first hundred without losing the selected scenario', async () => {
    const f = setup({
      listPage: (offset, saved) => ({
        items:
          offset === 0
            ? saved
              ? [summary(saved)]
              : []
            : [{ ...summary(alternative()), id: secondId, label: '오래된 대안' }],
        total: 101,
      }),
    });
    const next = await screen.findByRole('button', { name: '다음 시나리오 페이지' });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await screen.findByRole('button', { name: '시나리오 오래된 대안 선택' });
    expect(screen.getByRole('heading', { name: '시나리오 A · 수정 1' })).toBeVisible();
    expect(
      f.request.mock.calls.some(
        ([input]) => input.path.includes('plan-scenarios?') && input.path.includes('offset=100'),
      ),
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '이전 시나리오 페이지' }));
    await screen.findByRole('button', { name: '시나리오 A 선택' });
  });
  it('keeps a full separate draft through undo and saves only the scenario endpoint with unchanged legacy/null/zero values', async () => {
    const f = setup();
    const edit = await screen.findByRole('button', { name: '시나리오 초안 편집' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    const title = screen.getByRole('textbox', { name: '시나리오 계획 제목' });
    fireEvent.change(title, { target: { value: '독립 대안' } });
    expect(screen.getByRole('button', { name: '현재 계획 편집 대조' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '시나리오 실행 취소' }));
    expect(title).toHaveValue('합성 기준 계획');
    fireEvent.change(title, { target: { value: '독립 대안' } });
    await userEvent.click(screen.getByRole('button', { name: '시나리오 저장 미리보기' }));
    expect(f.writes).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 저장' }));
    await screen.findByRole('heading', { name: '시나리오 A · 수정 2' });
    const command = f.writes.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      method: 'PUT',
      path: `/bff/v1/plan-scenarios/${scenarioId}`,
      body: {
        expectedRevision: 1,
        draft: {
          title: '독립 대안',
          sessions: [{ durationSeconds: null, distanceMeters: 0, targetRpe: 0 }],
        },
      },
    });
    expect(
      f.request.mock.calls.some(
        ([input]) => input.method === 'PUT' && input.path.endsWith('/plans/current'),
      ),
    ).toBe(false);
    expect(f.store.getState().draft).toBeNull();
  });
  it('blocks edit/create/apply while a current-plan draft is open and protects saved scenario locks after an unsaved unlock', async () => {
    const f = setup({ manual: true });
    await screen.findByRole('heading', { name: '시나리오 A · 수정 1' });
    expect(screen.getByRole('button', { name: '시나리오 초안 편집' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '현재 계획 적용 미리보기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '시나리오 B 만들기' })).toBeDisabled();
    expect(f.writes).not.toHaveBeenCalled();
    f.unmount();
    const g = setup();
    await screen.findByRole('heading', { name: '시나리오 A · 수정 1' });
    act(() =>
      g.store.getState().start({
        ...alternative(),
        draft: {
          ...base().draft,
          sessions: base().draft.sessions.map((session) => ({
            ...session,
            locks: { ...session.locks, intensity: true },
          })),
        },
      }),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'intensity 잠금' }));
    expect(screen.getByRole('spinbutton', { name: '목표 RPE (0–10, 미정 가능)' })).toBeDisabled();
    expect(g.store.getState().draft?.sessions[0]?.locks.intensity).toBe(false);
  });
  it('keeps the exact apply command on response loss and acknowledges receipt only after explicit same-key retry', async () => {
    let attempts = 0;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (input.path.endsWith('/apply')) {
        attempts++;
        if (attempts === 1) throw new Error('response lost');
        return response({
          plan: { ...base(), id: secondId, version: 2 },
          scenarioId,
          scenarioRevision: 1,
        });
      }
      if (input.path === '/bff/v1/plans/current') return response({ head: base(), history: [] });
      if (input.path.endsWith('/session-completions'))
        return response({ currentPlanVersionId: baseId, collectionRevision: 7, items: [] });
      if (input.path.includes('/plans/versions/')) return response(base());
      if (input.path.includes('plan-scenarios?'))
        return response({
          items: [summary(alternative())],
          total: 1,
        });
      return response(alternative());
    });
    const f = setup({ override: request });
    const prepare = await screen.findByRole('button', { name: '현재 계획 적용 미리보기' });
    await waitFor(() => expect(prepare).toBeEnabled());
    await userEvent.click(prepare);
    await screen.findByRole('button', { name: '확인하고 현재 계획에 적용' });
    expect(request.mock.calls.filter(([input]) => input.method !== 'GET')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '확인하고 현재 계획에 적용' }));
    await userEvent.click(
      await screen.findByRole('button', { name: '같은 시나리오 요청 다시 확인' }),
    );
    await waitFor(() => expect(f.onApplied).toHaveBeenCalledOnce());
    const calls = request.mock.calls
      .filter(([input]) => input.path.endsWith('/apply'))
      .map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual(calls[1]?.body);
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);
    expect(calls[0]?.body).toEqual({
      confirmed: true,
      expectedScenarioRevision: 1,
      expectedPlanVersionId: baseId,
      expectedCompletionRevision: 7,
    });
  });
  it('preserves a conflicting draft and requires explicit latest-source review before a new save', async () => {
    let saved = alternative(),
      writes = 0;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (input.path.endsWith('/session-completions'))
        return response({ currentPlanVersionId: baseId, collectionRevision: 0, items: [] });
      if (input.path.includes('/plans/versions/')) return response(base());
      if (input.path.includes('plan-scenarios?'))
        return response({ items: [summary(saved)], total: 1 });
      if (input.method === 'PUT') {
        writes++;
        if (writes === 1) {
          saved = { ...saved, revision: 2, draft: { ...saved.draft, title: '다른 수정' } };
          return response(null, 409);
        }
        if (typeof input.body !== 'object' || input.body === null || Array.isArray(input.body))
          throw new Error('Missing command');
        const command = planScenarioSaveSchema.parse({
          ...input.body,
          idempotencyKey: input.idempotencyKey,
        });
        saved = { ...saved, revision: 3, draft: command.draft };
        return response(saved);
      }
      return response(saved);
    });
    const f = setup({ override: request });
    const edit = await screen.findByRole('button', { name: '시나리오 초안 편집' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    fireEvent.change(screen.getByRole('textbox', { name: '시나리오 계획 제목' }), {
      target: { value: '보존할 내 대안' },
    });
    await userEvent.click(screen.getByRole('button', { name: '시나리오 저장 미리보기' }));
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 저장' }));
    const review = await screen.findByRole('button', {
      name: '최신 시나리오를 기준으로 초안 다시 검토',
    });
    expect(screen.getByRole('textbox', { name: '시나리오 계획 제목' })).toHaveValue(
      '보존할 내 대안',
    );
    expect(f.store.getState().source?.revision).toBe(1);
    expect(writes).toBe(1);
    await userEvent.click(review);
    expect(f.store.getState().source?.revision).toBe(2);
    await userEvent.click(screen.getByRole('button', { name: '시나리오 저장 미리보기' }));
    expect(writes).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 저장' }));
    await screen.findByRole('heading', { name: '시나리오 A · 수정 3' });
    expect(saved.draft.title).toBe('보존할 내 대안');
  });

  it('aborts an in-flight save on account replacement and never restores its private draft from a late reply', async () => {
    let resolve:
      ((value: Awaited<ReturnType<AuthenticatedTransport['request']>>) => void) | undefined;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (input.method === 'PUT')
        return new Promise((done) => {
          resolve = done;
        });
      if (input.path.endsWith('/session-completions'))
        return response({ currentPlanVersionId: baseId, collectionRevision: 0, items: [] });
      if (input.path.includes('/plans/versions/')) return response(base());
      if (input.path.includes('plan-scenarios?'))
        return response({ items: [summary(alternative())], total: 1 });
      return response(alternative());
    });
    const f = setup({ override: request });
    const edit = await screen.findByRole('button', { name: '시나리오 초안 편집' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    fireEvent.change(screen.getByRole('textbox', { name: '시나리오 계획 제목' }), {
      target: { value: 'Alice 비공개 대안' },
    });
    await userEvent.click(screen.getByRole('button', { name: '시나리오 저장 미리보기' }));
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 저장' }));
    const pending = request.mock.calls.find(([input]) => input.method === 'PUT')?.[0];
    const next = createScenarioDraftStore();
    f.rerender(
      <QueryClientProvider client={f.client}>
        <PlanScenarioPanel
          athleteId="bob"
          sessionId="other-auth"
          transport={{ request }}
          current={{ head: base(), history: [] }}
          search={`scenarioBase=${baseId}`}
          onSearchChange={() => {}}
          manualDraftActive={false}
          store={next}
          onApplied={f.onApplied}
          today="2080-01-01"
          createId={() => 'bob-scenario-key'}
        />
      </QueryClientProvider>,
    );
    expect(pending?.signal?.aborted).toBe(true);
    await act(async () =>
      resolve?.(
        response({
          ...alternative(),
          revision: 2,
          draft: { ...base().draft, title: 'Alice 비공개 대안' },
        }),
      ),
    );
    expect(next.getState().draft).toBeNull();
    expect(f.store.getState().draft).toBeNull();
    expect(screen.queryByText('Alice 비공개 대안')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '시나리오 변경 확인' })).not.toBeInTheDocument();
  });

  it('clears private drafts and frozen requests after 401 instead of retaining a retryable command', async () => {
    let unauthorized = false;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (unauthorized) return response(null, 401);
      if (input.path.endsWith('/session-completions'))
        return response({ currentPlanVersionId: baseId, collectionRevision: 0, items: [] });
      if (input.path.includes('/plans/versions/')) return response(base());
      if (input.path.includes('plan-scenarios?'))
        return response({
          items: [summary(alternative())],
          total: 1,
        });
      return response(alternative());
    });
    const f = setup({ override: request });
    const edit = await screen.findByRole('button', { name: '시나리오 초안 편집' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    fireEvent.change(screen.getByRole('textbox', { name: '시나리오 계획 제목' }), {
      target: { value: '폐기할 비공개 대안' },
    });
    await userEvent.click(screen.getByRole('button', { name: '시나리오 저장 미리보기' }));
    unauthorized = true;
    await userEvent.click(screen.getByRole('button', { name: '확인하고 시나리오 저장' }));
    await screen.findByText(/로그인을 다시 확인하세요. 이 계정의 시나리오 초안/);
    expect(f.store.getState().draft).toBeNull();
    expect(f.store.getState().phase).toBe('idle');
    expect(screen.queryByText('폐기할 비공개 대안')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '같은 시나리오 요청 다시 확인' }),
    ).not.toBeInTheDocument();
  });
});

describe('immutable cross-scenario comparison', () => {
  it('keeps a compared scenario selected after its list page changes and preserves it on resubmit', async () => {
    const a = alternative();
    const b: PlanScenario = { ...a, id: secondId, label: 'B', revision: 2 };
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      response(input.path.includes(secondId) ? b : a),
    );
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const search = `scenarioCompareFromId=${a.id}&scenarioCompareFrom=1&scenarioCompareToId=${b.id}&scenarioCompareTo=2`;
    const renderComparison = (items: PlanScenario[]) => (
      <QueryClientProvider client={client}>
        <ScenarioComparison
          scenario={a}
          alternatives={items.map(summary)}
          transport={{ request }}
          scope={['alice', 'scenario']}
          search={search}
          onChange={onChange}
        />
      </QueryClientProvider>
    );
    const view = render(renderComparison([a, b]));
    await screen.findByText(/시나리오 A 수정 1 → 시나리오 B 수정 2/);
    const compared = screen.getByRole('combobox', { name: '이후 비교 시나리오' });
    expect(compared).toHaveValue(secondId);
    view.rerender(renderComparison([a]));
    expect(compared).toHaveValue(secondId);
    expect(
      within(compared).getByRole('option', { name: /시나리오 B · 선택 수정 2/ }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '시나리오 수정 비교하기' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCompareFromId: a.id, scenarioCompareToId: b.id }),
    );
  });
  it('reads independent A/B revisions by stable IDs and preserves legacy/null/zero under a period scope', async () => {
    const a = alternative(),
      b: PlanScenario = {
        ...alternative(),
        id: secondId,
        label: 'B',
        revision: 2,
        draft: {
          ...base().draft,
          title: 'B 대안',
          sessions: base().draft.sessions.map((session) => ({
            ...session,
            notes: 'B 메모',
            targetRpe: 0,
            durationSeconds: null,
            distanceMeters: 0,
          })),
        },
      };
    const originalA = structuredClone(a),
      originalB = structuredClone(b);
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      response(input.path.includes(secondId) ? b : a),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ScenarioComparison
          scenario={a}
          alternatives={[
            { ...a, title: a.draft.title },
            { ...b, title: b.draft.title },
          ]}
          transport={{ request }}
          scope={['alice', 'scenario']}
          search={`scenarioCompareFromId=${a.id}&scenarioCompareFrom=1&scenarioCompareToId=${b.id}&scenarioCompareTo=2&scenarioPeriod=block`}
          onChange={() => {}}
        />
      </QueryClientProvider>,
    );
    await screen.findByText(/시나리오 A 수정 1 → 시나리오 B 수정 2/);
    expect(screen.getByText(/세션 합성 세션 · ID run · 변경/)).toBeVisible();
    await userEvent.click(screen.getByText('이후 시나리오 범위 본문'));
    const contents = screen.getByText('이후 시나리오 범위 본문').closest('details');
    if (!contents) throw new Error('Missing compared body');
    expect(within(contents).getByText(/시간: 미정 · 거리: 0m · RPE: 0/)).toBeVisible();
    expect(a).toEqual(originalA);
    expect(b).toEqual(originalB);
    expect(request.mock.calls.map(([input]) => input.path).sort()).toEqual(
      [
        `/bff/v1/plan-scenarios/${a.id}/revisions/1`,
        `/bff/v1/plan-scenarios/${b.id}/revisions/2`,
      ].sort(),
    );
  });
});
