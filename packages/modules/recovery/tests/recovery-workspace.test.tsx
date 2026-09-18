import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  recoveryStrategyDraftSchema,
  recoveryStrategyVersionSchema,
  recoveryWorkspaceReadSchema,
  recoveryActionLogSchema,
  recoveryMethodVersionSchema,
  type RecoveryStrategyVersion,
} from '@workout/contracts/recovery-core';
import { RecoveryWorkspace } from '../src/recovery-workspace';

const originalCrypto = globalThis.crypto;
let nextId = 0;
beforeEach(() => {
  nextId = 0;
  vi.stubGlobal('crypto', {
    randomUUID() {
      nextId += 1;
      return `10000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
    },
  });
});
afterEach(() => vi.stubGlobal('crypto', originalCrypto));

it('keeps full rest as a real strategy choice without creating an actual or changing another plan', async () => {
  let strategies: RecoveryStrategyVersion[] = [];
  const requests: { path: string; body: unknown }[] = [];
  const transport: AuthenticatedTransport = {
    async request(input) {
      requests.push({ path: input.path, body: input.body });
      if (input.path === '/bff/v1/recovery' && input.method === 'GET') {
        return {
          status: 200,
          body: {
            methods: [],
            strategies,
            actions: [],
            observations: [],
            planRefs: [],
            reassessment: [],
          },
          traceId: null,
        };
      }
      if (input.path === '/bff/v1/recovery/strategy-drafts') {
        const draft = recoveryStrategyDraftSchema.parse((input.body as { draft: unknown }).draft);
        const strategy = recoveryStrategyVersionSchema.parse({
          schemaVersion: 1,
          strategyId: '10000000-0000-4000-8000-000000000001',
          versionId: '10000000-0000-4000-8000-000000000002',
          version: 1,
          previousVersionId: null,
          status: 'draft',
          selectedOptionId: null,
          createdAt: '2026-09-18T10:00:00.000Z',
          draft,
        });
        strategies = [strategy];
        return { status: 200, body: strategy, traceId: null };
      }
      if (input.path.endsWith('/confirm')) {
        const previous = strategies[0];
        if (!previous) throw new Error('STRATEGY_MISSING');
        const body = input.body as { selectedOptionId: string };
        const confirmed = recoveryStrategyVersionSchema.parse({
          ...previous,
          versionId: '10000000-0000-4000-8000-000000000003',
          version: 2,
          previousVersionId: previous.versionId,
          status: 'user_confirmed',
          selectedOptionId: body.selectedOptionId,
        });
        strategies = [confirmed];
        return { status: 200, body: confirmed, traceId: null };
      }
      return { status: 404, body: { error: { code: 'UNEXPECTED_ROUTE' } }, traceId: null };
    },
  };
  render(<RecoveryWorkspace athleteId="owner" sessionId="session" transport={transport} />);
  await screen.findByText('저장된 전략이 없습니다.');
  fireEvent.change(screen.getByLabelText('제목'), { target: { value: '쉬고 다시 확인' } });
  fireEvent.change(screen.getByLabelText('시작 날짜'), { target: { value: '2026-09-18' } });
  fireEvent.change(screen.getByLabelText('종료 날짜 (미포함)'), {
    target: { value: '2026-09-20' },
  });
  fireEvent.change(screen.getByLabelText('다시 확인할 시점'), {
    target: { value: '2026-09-19T09:00' },
  });
  await userEvent.click(screen.getByRole('button', { name: '전략 초안 저장' }));
  expect(requests.map((request) => request.path)).toContain('/bff/v1/recovery/strategy-drafts');
  await screen.findByText(/초안 · 아직 선택 확인 전/);
  const created = requests.find((request) => request.path === '/bff/v1/recovery/strategy-drafts');
  expect(created).toBeDefined();
  expect((created?.body as { draft: { options: { kind: string }[] } }).draft.options[0]?.kind).toBe(
    'full_rest',
  );
  expect(requests.some((request) => request.path.includes('/action-logs'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '이 안을 명시적으로 선택' }));
  await waitFor(() => expect(screen.getByText(/사용자가 선택 확인함/)).toBeTruthy());
  const confirmed = requests.find((request) => request.path.endsWith('/confirm'));
  expect(confirmed).toBeDefined();
  expect(requests.some((request) => request.path.includes('/plans'))).toBe(false);
  expect(screen.getByText('확인된 행동 기록이 없습니다.')).toBeTruthy();
});

it('shows unreviewed method provenance, corrects only the action revision, and clears account-scoped UI', async () => {
  const methodId = '20000000-0000-4000-8000-000000000001';
  const actionId = '20000000-0000-4000-8000-000000000002';
  const method = {
    schemaVersion: 1,
    methodId,
    versionId: methodId,
    version: 1,
    title: '개인 휴식 방법',
    category: 'rest',
    intendedUse: '개인 기록',
    applicability: [],
    cautions: ['불편하면 중단'],
    sourceDescription: '사용자 메모',
    evidenceLimitations: '효과 검토 전',
    reviewState: 'unreviewed',
    reviewedAt: null,
    source: 'user_recorded',
    createdAt: '2026-09-18T10:00:00.000Z',
  };
  let action = {
    schemaVersion: 1,
    actionId,
    revisionId: '20000000-0000-4000-8000-000000000003',
    revision: 1,
    status: 'active',
    methodVersionId: methodId,
    strategyVersionId: null,
    plannedOptionId: null,
    occurredAt: '2026-09-18T10:00:00.000Z',
    recordedAt: '2026-09-18T10:05:00.000Z',
    timezone: 'UTC',
    state: 'performed',
    durationSeconds: null,
    actualConditions: '쉬기',
    beforeCheckIn: null,
    afterCheckIn: null,
    discomfort: '',
    userNotes: '기록',
    source: 'user_confirmed',
  };
  recoveryWorkspaceReadSchema.parse({
    methods: [method],
    strategies: [],
    actions: [action],
    observations: [],
    planRefs: [],
    reassessment: [],
  });
  const requests: { path: string; body: unknown }[] = [];
  const ownerTransport: AuthenticatedTransport = {
    async request(input) {
      requests.push({ path: input.path, body: input.body });
      if (input.method === 'GET') {
        return {
          status: 200,
          body: {
            methods: [method],
            strategies: [],
            actions: [action],
            observations: [],
            planRefs: [],
            reassessment: [],
          },
          traceId: null,
        };
      }
      if (input.method === 'PATCH') {
        action = {
          ...action,
          revisionId: '20000000-0000-4000-8000-000000000004',
          revision: 2,
          state: (input.body as { state: string }).state,
          userNotes: (input.body as { userNotes: string }).userNotes,
        };
        return { status: 200, body: action, traceId: null };
      }
      return { status: 404, body: { error: { code: 'UNEXPECTED_ROUTE' } }, traceId: null };
    },
  };
  const otherTransport: AuthenticatedTransport = {
    async request() {
      return {
        status: 200,
        body: {
          methods: [],
          strategies: [],
          actions: [],
          observations: [],
          planRefs: [],
          reassessment: [],
        },
        traceId: null,
      };
    },
  };
  const view = render(
    <RecoveryWorkspace athleteId="owner" sessionId="first" transport={ownerTransport} />,
  );
  await screen.findByRole('heading', { level: 3, name: '개인 휴식 방법' });
  expect(screen.getByText('검토 상태: 미검토 · 개인 수동 기록용')).toBeTruthy();
  expect(screen.getByText('근거 한계: 효과 검토 전')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '정정' }));
  const correctionForm = screen.getByRole('button', { name: '정정 저장' }).closest('form');
  if (!correctionForm) throw new Error('CORRECTION_FORM_MISSING');
  fireEvent.change(within(correctionForm).getByLabelText('수행 상태'), {
    target: { value: 'partial' },
  });
  fireEvent.change(within(correctionForm).getByLabelText('내 기록'), {
    target: { value: '일부만 수행' },
  });
  await userEvent.click(screen.getByRole('button', { name: '정정 저장' }));
  await waitFor(() =>
    expect(
      requests.some((request) => request.path === `/bff/v1/recovery/action-logs/${actionId}`),
    ).toBe(true),
  );
  const changed = requests.find(
    (request) => request.path === `/bff/v1/recovery/action-logs/${actionId}`,
  );
  expect(changed?.body).toMatchObject({
    expectedRevision: 1,
    state: 'partial',
    userNotes: '일부만 수행',
  });
  view.rerender(
    <RecoveryWorkspace athleteId="other" sessionId="second" transport={otherTransport} />,
  );
  await screen.findByText('확인된 행동 기록이 없습니다.');
  expect(screen.queryByText('개인 휴식 방법')).toBeNull();
});

function actionFixtures() {
  const method = recoveryMethodVersionSchema.parse({
    schemaVersion: 1,
    methodId: '30000000-0000-4000-8000-000000000001',
    versionId: '30000000-0000-4000-8000-000000000002',
    version: 1,
    title: '개인 취침 준비',
    category: 'sleep_preparation',
    intendedUse: '',
    applicability: [],
    cautions: [],
    sourceDescription: '사용자 기록',
    evidenceLimitations: '미검토',
    reviewState: 'unreviewed',
    reviewedAt: null,
    source: 'user_recorded',
    createdAt: '2026-09-18T09:00:00.000Z',
  });
  const action = recoveryActionLogSchema.parse({
    schemaVersion: 1,
    actionId: '30000000-0000-4000-8000-000000000003',
    revisionId: '30000000-0000-4000-8000-000000000004',
    revision: 1,
    status: 'active',
    recordedAt: '2026-09-18T10:05:00.000Z',
    methodVersionId: method.versionId,
    strategyVersionId: null,
    plannedOptionId: null,
    occurredAt: '2026-09-18T10:00:17.456Z',
    timezone: 'America/New_York',
    state: 'performed',
    durationSeconds: null,
    actualConditions: '',
    beforeCheckIn: null,
    afterCheckIn: null,
    discomfort: '',
    userNotes: '초기 메모',
    source: 'user_confirmed',
  });
  const workspace = (actions: (typeof action)[]) =>
    recoveryWorkspaceReadSchema.parse({
      methods: [method],
      strategies: [],
      actions,
      observations: [],
      planRefs: [],
      reassessment: [],
    });
  return { method, action, workspace };
}

it('freezes an uncertain action creation and retries the identical body and key', async () => {
  const { method, action, workspace } = actionFixtures();
  const writes: { body: unknown; key: string | null | undefined }[] = [];
  let saved = false;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'GET')
        return { status: 200, body: workspace(saved ? [action] : []), traceId: null };
      if (input.path === '/bff/v1/recovery/action-logs') {
        writes.push({ body: input.body, key: input.idempotencyKey });
        saved = true;
        if (writes.length === 1) throw new Error('response lost after commit');
        return { status: 200, body: action, traceId: null };
      }
      return { status: 404, body: { error: { code: 'UNEXPECTED_ROUTE' } }, traceId: null };
    },
  };
  render(<RecoveryWorkspace athleteId="owner" sessionId="session" transport={transport} />);
  const form = (await screen.findByRole('button', { name: '행동 저장' })).closest('form');
  if (!form) throw new Error('ACTION_FORM_MISSING');
  await userEvent.selectOptions(within(form).getByLabelText('방법'), method.versionId);
  fireEvent.change(within(form).getByLabelText('실제 시각'), {
    target: { value: '2026-09-18T10:00' },
  });
  fireEvent.change(within(form).getByLabelText('내 기록'), { target: { value: '첫 요청' } });
  await userEvent.click(within(form).getByRole('button', { name: '행동 저장' }));
  await within(form).findByRole('button', { name: '같은 요청 다시 시도' });
  expect((form.querySelector('fieldset') as HTMLFieldSetElement | null)?.disabled).toBe(true);
  await userEvent.click(within(form).getByRole('button', { name: '같은 요청 다시 시도' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  await screen.findByText('개인 취침 준비 · performed');
});

it('does not turn lost method or strategy responses into second creations', async () => {
  const { method, workspace } = actionFixtures();
  let methods: (typeof method)[] = [];
  let strategies: RecoveryStrategyVersion[] = [];
  const methodWrites: { body: unknown; key: string | null | undefined }[] = [];
  const strategyWrites: { body: unknown; key: string | null | undefined }[] = [];
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'GET') {
        return {
          status: 200,
          body: { ...workspace([]), methods, strategies },
          traceId: null,
        };
      }
      if (input.path === '/bff/v1/recovery/methods') {
        methodWrites.push({ body: input.body, key: input.idempotencyKey });
        methods = [method];
        if (methodWrites.length === 1) throw new Error('method response lost');
        return { status: 200, body: method, traceId: null };
      }
      if (input.path === '/bff/v1/recovery/strategy-drafts') {
        strategyWrites.push({ body: input.body, key: input.idempotencyKey });
        const draft = recoveryStrategyDraftSchema.parse((input.body as { draft: unknown }).draft);
        const strategy = recoveryStrategyVersionSchema.parse({
          schemaVersion: 1,
          strategyId: '30000000-0000-4000-8000-000000000007',
          versionId: '30000000-0000-4000-8000-000000000008',
          version: 1,
          previousVersionId: null,
          status: 'draft',
          selectedOptionId: null,
          createdAt: '2026-09-18T10:00:00.000Z',
          draft,
        });
        strategies = [strategy];
        if (strategyWrites.length === 1) throw new Error('strategy response lost');
        return { status: 200, body: strategy, traceId: null };
      }
      return { status: 404, body: { error: { code: 'UNEXPECTED_ROUTE' } }, traceId: null };
    },
  };
  render(<RecoveryWorkspace athleteId="owner" sessionId="session" transport={transport} />);
  const methodForm = (await screen.findByRole('button', { name: '방법 저장' })).closest('form');
  if (!methodForm) throw new Error('METHOD_FORM_MISSING');
  fireEvent.change(within(methodForm).getByLabelText('방법 이름'), {
    target: { value: method.title },
  });
  await userEvent.click(within(methodForm).getByRole('button', { name: '방법 저장' }));
  await within(methodForm).findByRole('button', { name: '같은 방법 요청 다시 시도' });
  expect((methodForm.querySelector('fieldset') as HTMLFieldSetElement | null)?.disabled).toBe(true);
  await userEvent.click(
    within(methodForm).getByRole('button', { name: '같은 방법 요청 다시 시도' }),
  );
  await waitFor(() => expect(methodWrites).toHaveLength(2));
  expect(methodWrites[1]).toEqual(methodWrites[0]);

  const strategyForm = screen.getByRole('button', { name: '전략 초안 저장' }).closest('form');
  if (!strategyForm) throw new Error('STRATEGY_FORM_MISSING');
  fireEvent.change(within(strategyForm).getByLabelText('제목'), {
    target: { value: '쉬고 다시 확인' },
  });
  fireEvent.change(within(strategyForm).getByLabelText('시작 날짜'), {
    target: { value: '2026-09-18' },
  });
  fireEvent.change(within(strategyForm).getByLabelText('종료 날짜 (미포함)'), {
    target: { value: '2026-09-20' },
  });
  fireEvent.change(within(strategyForm).getByLabelText('다시 확인할 시점'), {
    target: { value: '2026-09-19T09:00' },
  });
  await userEvent.click(within(strategyForm).getByRole('button', { name: '전략 초안 저장' }));
  await within(strategyForm).findByRole('button', { name: '같은 전략 요청 다시 시도' });
  expect((strategyForm.querySelector('fieldset') as HTMLFieldSetElement | null)?.disabled).toBe(
    true,
  );
  await userEvent.click(
    within(strategyForm).getByRole('button', { name: '같은 전략 요청 다시 시도' }),
  );
  await waitFor(() => expect(strategyWrites).toHaveLength(2));
  expect(strategyWrites[1]).toEqual(strategyWrites[0]);
  await screen.findByText('쉬고 다시 확인');
});

it('keeps a correction draft through refetch failure and revision change, then preserves untouched instant and timezone', async () => {
  const { action, workspace } = actionFixtures();
  let current = action;
  let failNextRead = false;
  let submitted: unknown = null;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'GET') {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('background read failed');
        }
        return { status: 200, body: workspace([current]), traceId: null };
      }
      if (input.method === 'PATCH') {
        submitted = input.body;
        current = recoveryActionLogSchema.parse({
          ...current,
          revision: current.revision + 1,
          revisionId: '30000000-0000-4000-8000-000000000006',
          ...(input.body as object),
          recordedAt: '2026-09-18T11:00:00.000Z',
        });
        return { status: 200, body: current, traceId: null };
      }
      return { status: 404, body: { error: { code: 'UNEXPECTED_ROUTE' } }, traceId: null };
    },
  };
  render(<RecoveryWorkspace athleteId="owner" sessionId="session" transport={transport} />);
  await screen.findByText('개인 취침 준비 · performed');
  await userEvent.click(screen.getByRole('button', { name: '정정' }));
  const correctionForm = screen.getByRole('button', { name: '정정 저장' }).closest('form');
  if (!correctionForm) throw new Error('CORRECTION_FORM_MISSING');
  fireEvent.change(within(correctionForm).getByLabelText('내 기록'), {
    target: { value: '작성 중인 정정' },
  });
  failNextRead = true;
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await screen.findByText('최신 기록을 불러오지 못했습니다. 편집 중인 입력은 유지됩니다.');
  expect((within(correctionForm).getByLabelText('내 기록') as HTMLTextAreaElement).value).toBe(
    '작성 중인 정정',
  );
  current = recoveryActionLogSchema.parse({
    ...current,
    revision: 2,
    revisionId: '30000000-0000-4000-8000-000000000005',
    userNotes: '다른 기기에서 정정',
  });
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByText('다른 변경이 반영되었습니다. 입력을 유지하며 정정 저장은 멈췄습니다.');
  expect((within(correctionForm).getByLabelText('내 기록') as HTMLTextAreaElement).value).toBe(
    '작성 중인 정정',
  );
  expect(
    (within(correctionForm).getByRole('button', { name: '정정 저장' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: '최신 기록으로 다시 입력' }));
  const refreshedForm = screen.getByRole('button', { name: '정정 저장' }).closest('form');
  if (!refreshedForm) throw new Error('REFRESHED_FORM_MISSING');
  fireEvent.change(within(refreshedForm).getByLabelText('내 기록'), {
    target: { value: '메모만 정정' },
  });
  await userEvent.click(within(refreshedForm).getByRole('button', { name: '정정 저장' }));
  await waitFor(() => expect(submitted).not.toBeNull());
  expect(submitted).toMatchObject({
    expectedRevision: 2,
    occurredAt: action.occurredAt,
    timezone: 'America/New_York',
    userNotes: '메모만 정정',
  });
  focusManager.setFocused(undefined);
});

it('replays an uncertain correction after the server revision appears in a refetch', async () => {
  const { action, workspace } = actionFixtures();
  let current = action;
  const writes: { body: unknown; key: string | null | undefined }[] = [];
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'GET') return { status: 200, body: workspace([current]), traceId: null };
      if (input.method === 'PATCH') {
        writes.push({ body: input.body, key: input.idempotencyKey });
        if (writes.length === 1) {
          current = recoveryActionLogSchema.parse({
            ...current,
            revision: 2,
            revisionId: '30000000-0000-4000-8000-000000000009',
            userNotes: '서버에 저장됨',
          });
          throw new Error('correction response lost');
        }
        return { status: 200, body: current, traceId: null };
      }
      return { status: 404, body: { error: { code: 'UNEXPECTED_ROUTE' } }, traceId: null };
    },
  };
  render(<RecoveryWorkspace athleteId="owner" sessionId="session" transport={transport} />);
  await screen.findByText('개인 취침 준비 · performed');
  await userEvent.click(screen.getByRole('button', { name: '정정' }));
  const correctionForm = screen.getByRole('button', { name: '정정 저장' }).closest('form');
  if (!correctionForm) throw new Error('CORRECTION_FORM_MISSING');
  fireEvent.change(within(correctionForm).getByLabelText('내 기록'), {
    target: { value: '서버에 저장됨' },
  });
  await userEvent.click(within(correctionForm).getByRole('button', { name: '정정 저장' }));
  await within(correctionForm).findByRole('button', { name: '같은 요청 다시 시도' });
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await screen.findByText(
    '다른 변경이 반영되었습니다. 이전 정정 요청의 결과를 같은 키로 다시 확인해 주세요.',
  );
  expect(screen.queryByRole('button', { name: '최신 기록으로 다시 입력' })).toBeNull();
  expect(
    (within(correctionForm).getByRole('button', { name: '정정 취소' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      within(correctionForm).getByRole('button', {
        name: '같은 요청 다시 시도',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await userEvent.click(
    within(correctionForm).getByRole('button', { name: '같은 요청 다시 시도' }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  await waitFor(() => expect(screen.queryByRole('button', { name: '정정 취소' })).toBeNull());
  focusManager.setFocused(undefined);
});
