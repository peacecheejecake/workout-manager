import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { raceManualPublicPrepareSchema } from '@workout/contracts/race-manual-public';
import { raceEventSchema } from '@workout/contracts/races';
import { raceManualPublicPreviewSchema } from '@workout/contracts/race-manual-public-preview';
import { createRaceManualPublicApi } from '../src/race-manual-public-api';
import {
  RaceDateChangeReview,
  type RaceDateChangeReviewProps,
} from '../src/race-date-change-review';
afterEach(cleanup);
const id = 'abcdefab-abcd-4abc-8abc-000000000001';
const candidateId = 'abcdefab-abcd-4abc-8abc-000000000002';
const stamp = '2026-10-08T00:00:00.123456Z';
const event = raceEventSchema.parse({
  id,
  revision: 1,
  title: '가을 대회',
  localDate: '2026-10-08',
  localStartTime: null,
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '5k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
});
const reference = {
  schemaVersion: 1,
  candidateId,
  applicationDigest: 'a'.repeat(64),
  chain: {
    evidenceId: 'abcdefab-abcd-4abc-8abc-000000000003',
    decisionId: 'abcdefab-abcd-4abc-8abc-000000000004',
    proposalId: 'abcdefab-abcd-4abc-8abc-000000000005',
    readonlyCandidateDigest: 'b'.repeat(64),
  },
  createdAt: stamp,
};
const beforeRace = {
  title: event.title,
  localDate: event.localDate,
  localStartTime: null,
  timezone: 'UTC',
  distance: event.distance,
  priority: null,
  participation: 'registered',
  targetSeconds: 0,
};
function basePreview() {
  return {
    schemaVersion: 1,
    status: 'present',
    reference,
    storedCandidateState: 'ready_for_explicit_approval',
    beforeBasis: 'frozen_review',
    afterBasis: 'hypothetical_on_approval',
    freshness: 'not_checked_on_read',
    scope: 'whole_affected',
    race: {
      eventId: id,
      expectedRevision: 1,
      before: beforeRace,
      after: { ...beforeRace, localDate: '2026-10-09' },
    },
    training: { state: 'absent' },
    nutrition: { state: 'absent' },
    recovery: { state: 'absent' },
    routines: { state: 'absent' },
    retainedUnplanned: [],
    affected: [],
    notices: [],
  };
}
const committed = {
  schemaVersion: 1,
  status: 'committed',
  candidateId,
  approvalId: 'abcdefab-abcd-4abc-8abc-000000000006',
  proposalId: reference.chain.proposalId,
  approvedAt: stamp,
  race: { eventId: id, revision: 2 },
  versions: [],
  occurrenceIds: [],
  notices: [],
};
function setup(
  preview: unknown = basePreview(),
  overrides: Partial<RaceDateChangeReviewProps> = {},
) {
  const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
    const body =
      input.method === 'GET'
        ? preview
        : input.path.endsWith('/approve')
          ? committed
          : { status: 'reviewed', reference, bodyState: 'present' };
    return transportReplySchema.parse({
      status: input.method === 'POST' && !input.path.endsWith('/approve') ? 201 : 200,
      body,
      traceId: null,
    });
  });
  const props: RaceDateChangeReviewProps = {
    scopeKey: 'athlete-session-a',
    support: 'supported',
    event,
    api: createRaceManualPublicApi({ request }),
    loadCurrentPlan: vi.fn(async () => ({ head: null, history: [] })),
    commandKey: vi.fn(() => 'stable_request_0001'),
    onCommitted: vi.fn(),
    ...overrides,
  };
  const view = render(<RaceDateChangeReview {...props} />);
  return { request, props, view };
}
async function review() {
  const user = userEvent.setup();
  await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.');
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-09' } });
  await user.selectOptions(screen.getByLabelText('계획 비교 방식'), 'keep_plan');
  await user.click(screen.getByRole('button', { name: '전체 영향 검토' }));
  return user;
}
it('requires explicit comparison, does not autoapprove, uses frozen basis and confirms commit only', async () => {
  const { request, props } = setup();
  expect(screen.getByLabelText('계획 비교 방식')).toHaveValue('');
  expect(screen.getByRole('button', { name: '전체 영향 검토' })).toBeDisabled();
  const user = await review();
  const checkbox = await screen.findByRole('checkbox');
  expect(checkbox).toHaveFocus();
  expect(screen.getByRole('button', { name: '계획 변경 승인' })).toBeDisabled();
  expect(request.mock.calls.filter(([r]) => r.path.endsWith('/approve'))).toHaveLength(0);
  expect(screen.getByText(/저장된 검토는 현재 승인 권한/)).toBeInTheDocument();
  for (const domain of ['대회', '훈련', '영양', '회복', '루틴'])
    expect(screen.getByRole('heading', { name: domain })).toBeInTheDocument();
  await user.click(checkbox);
  await user.click(screen.getByRole('button', { name: '계획 변경 승인' }));
  expect(
    await screen.findByText('날짜와 영향받는 계획의 승인이 서버에 반영되었습니다.'),
  ).toBeInTheDocument();
  expect(props.onCommitted).toHaveBeenCalledExactlyOnceWith(committed);
  expect(request.mock.calls.map(([r]) => r.method)).toEqual(['POST', 'GET', 'POST']);
});
it.each(['unsupported', 'unknown'] as const)('does not call ports for %s support', (support) => {
  const { request, props } = setup(undefined, { support });
  expect(screen.getByRole('status')).toHaveTextContent('검토 지원을 확인할 수 없습니다');
  expect(request).not.toHaveBeenCalled();
  expect(props.loadCurrentPlan).not.toHaveBeenCalled();
});
it('handles missing/invalid plan read without inventing an empty current plan', async () => {
  const { request } = setup(undefined, { loadCurrentPlan: async () => null });
  expect(await screen.findByRole('alert')).toHaveTextContent('현재 계획을 확인할 수 없어');
  expect(screen.getByRole('button', { name: '전체 영향 검토' })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});
it('shows unavailable when callback absent', () => {
  const { request } = setup(undefined, { loadCurrentPlan: null });
  expect(screen.getByRole('status')).toHaveTextContent('현재 계획 조회가 제공되지 않아');
  expect(request).not.toHaveBeenCalled();
});
it('keeps purge reference-only, with no confirm or approve controls', async () => {
  const { props } = setup({
    schemaVersion: 1,
    status: 'unavailable',
    reference,
    reason: 'review_body_purged',
    preview: null,
  });
  await review();
  expect(await screen.findByLabelText('검토 자료 사용 불가')).toHaveTextContent('최소 검토 참조만');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(props.onCommitted).not.toHaveBeenCalled();
});
it('preserves finite blocked stage and input without fabricating a preview', async () => {
  const { request } = setup();
  request.mockResolvedValue(
    transportReplySchema.parse({
      status: 409,
      body: { status: 'blocked', stage: 'semantic' },
      traceId: null,
    }),
  );
  await review();
  expect(await screen.findByText(/검토를 준비할 수 없습니다 \(semantic\)/)).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '입력을 유지하고 새 검토' }));
  expect(screen.getByLabelText('새 대회 날짜')).toHaveValue('2026-10-09');
  expect(screen.getByLabelText('계획 비교 방식')).toHaveValue('keep_plan');
});
it('retries uncertain review with the exact original key/body and locks edited inputs', async () => {
  const { request } = setup();
  request.mockRejectedValueOnce(new Error('raw private'));
  await review();
  const retry = await screen.findByRole('button', { name: '같은 검토 요청 다시 확인' });
  expect(screen.getByLabelText('새 대회 날짜')).toBeDisabled();
  expect(screen.queryByText('raw private')).not.toBeInTheDocument();
  await userEvent.click(retry);
  await screen.findByRole('checkbox');
  const writes = request.mock.calls.map(([r]) => r).filter((r) => r.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body).toEqual(writes[1]?.body);
  expect(writes[0]?.idempotencyKey).toBe(writes[1]?.idempotencyKey);
  expect(writes[0]?.path).toBe(writes[1]?.path);
  expect(writes[0]?.signal).not.toBe(writes[1]?.signal);
});
it('retries uncertain approval with its same reference/body/key and no premature success', async () => {
  const { request, props } = setup();
  const user = await review();
  await screen.findByRole('checkbox');
  const original = request.getMockImplementation();
  if (!original) throw Error('Handler required');
  let attempts = 0;
  request.mockImplementation(async (r) => {
    if (r.path.endsWith('/approve') && ++attempts === 1) throw Error('Lost response');
    return original(r);
  });
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '계획 변경 승인' }));
  const retry = await screen.findByRole('button', { name: '같은 승인 요청 다시 확인' });
  expect(props.onCommitted).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '입력을 유지하고 새 검토' })).not.toBeInTheDocument();
  await user.click(retry);
  await screen.findByText('날짜와 영향받는 계획의 승인이 서버에 반영되었습니다.');
  const writes = request.mock.calls.map(([r]) => r).filter((r) => r.path.endsWith('/approve'));
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body).toEqual(writes[1]?.body);
  expect(writes[0]?.idempotencyKey).toBe(writes[1]?.idempotencyKey);
  expect(writes[0]?.path).toBe(writes[1]?.path);
  expect(writes[0]?.signal).not.toBe(writes[1]?.signal);
  expect(props.onCommitted).toHaveBeenCalledTimes(1);
});
it('submits actual current period and snapshot version, never a guessed period', async () => {
  const draft = {
    title: '현재 훈련',
    timezone: 'UTC',
    periods: [
      {
        id: 'season',
        parentId: null,
        level: 'season',
        title: '실제 시즌',
        startDate: '2026-10-08',
        endDateExclusive: '2026-10-20',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
      },
    ],
    sessions: [],
  };
  const { request } = setup(undefined, {
    loadCurrentPlan: async () => ({
      head: { id: candidateId, version: 3, createdAt: stamp, draft },
      history: [],
    }),
  });
  await waitFor(() => expect(screen.getByLabelText('계획 비교 방식')).not.toBeDisabled());
  const user = userEvent.setup();
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-09' } });
  await user.selectOptions(screen.getByLabelText('계획 비교 방식'), 'move_period');
  await user.selectOptions(screen.getByLabelText('현재 계획의 기간'), 'season');
  fireEvent.change(screen.getByLabelText('기간의 새 시작 날짜'), {
    target: { value: '2026-10-09' },
  });
  await user.selectOptions(screen.getByLabelText('이동 범위'), 'descendants_and_sessions');
  await user.click(screen.getByRole('button', { name: '전체 영향 검토' }));
  await screen.findByRole('checkbox');
  expect(request.mock.calls[0]?.[0].body).toMatchObject({
    intent: {
      selection: {
        kind: 'move_period',
        expectedCurrentPlanVersionId: candidateId,
        periodId: 'season',
        newStartDate: '2026-10-09',
        scope: 'descendants_and_sessions',
      },
    },
  });
});
it('does not submit during IME composition and supports keyboard confirmation', async () => {
  const { request } = setup();
  await screen.findByText(/현재 훈련 계획 없음/);
  const user = userEvent.setup();
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-09' } });
  await user.selectOptions(screen.getByLabelText('계획 비교 방식'), 'keep_plan');
  const input = screen.getByLabelText('새 대회 날짜');
  fireEvent.compositionStart(input);
  fireEvent.submit(input.closest('form') ?? input);
  expect(request).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await user.click(screen.getByRole('button', { name: '전체 영향 검토' }));
  await screen.findByRole('checkbox');
  await user.keyboard(' ');
  expect(screen.getByRole('button', { name: '계획 변경 승인' })).toBeEnabled();
});
it('resets private draft/reference on scope change and aborts pending requests', async () => {
  const { props, request, view } = setup();
  await review();
  await screen.findByRole('checkbox');
  view.rerender(<RaceDateChangeReview {...props} scopeKey="athlete-session-b" />);
  await screen.findByText(/현재 훈련 계획 없음/);
  expect(screen.getByLabelText('새 대회 날짜')).toHaveValue('');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
});
it('renders exact nutrition zero/null and disconnected timing without implicit reconnect', async () => {
  const nutrition = {
    period: { from: '2026-10-08', toInclusive: '2026-10-10' },
    purpose: '음식 보존',
    timezone: 'UTC',
    items: [
      {
        id: 'meal',
        category: 'before',
        title: '보존된 식사',
        anchor: { kind: 'disconnected', entity: 'race' },
        foods: [
          {
            foodVersionId: null,
            description: '음식 0',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
          {
            foodVersionId: null,
            description: '미상 음식',
            quantity: null,
            unit: 'unspecified',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: '그대로 먹기',
      },
    ],
  };
  const suspended = {
    state: 'suspended',
    reason: 'race_disconnected',
    resume: 'explicit_reconnect_and_reapproval_required',
  };
  const value = raceManualPublicPreviewSchema.parse({
    ...basePreview(),
    notices: [
      { domain: 'nutrition', aggregateId: id, itemId: 'meal', code: 'DISCONNECTED_RETAINED' },
    ],
    nutrition: {
      state: 'present',
      members: [
        {
          aggregateId: id,
          before: {
            ref: { versionId: candidateId, version: 1 },
            plan: nutrition,
            linkedTraining: { kind: 'absent' },
          },
          after: { kind: 'retained', plan: nutrition, linkedTraining: { kind: 'absent' } },
          timings: [{ itemId: 'meal', state: 'unchanged', before: suspended, after: suspended }],
        },
      ],
    },
  });
  setup(value);
  await review();
  await screen.findByRole('checkbox');
  const preview = screen.getByLabelText('전체 계획 영향 미리보기');
  expect(within(preview).getAllByText('음식 0')).toHaveLength(2);
  expect(within(preview).getAllByText('미상(null)').length).toBeGreaterThan(0);
  expect(within(preview).getAllByText('0').length).toBeGreaterThan(0);
  expect(within(preview).getByText(/영향 밖 보존/)).toHaveTextContent(
    '명시 재연결·재승인 전 시각 사용 중단',
  );
  expect(screen.queryByRole('button', { name: /재연결/ })).not.toBeInTheDocument();
});

it('shows full training goals, recovery choice, routine rule and started/unplanned preservation', async () => {
  const plan = {
    title: '훈련 본문',
    timezone: 'UTC',
    periods: [
      {
        id: 'season',
        parentId: null,
        level: 'season',
        title: '실제 시즌',
        startDate: '2026-10-08',
        endDateExclusive: '2026-10-20',
        timezone: 'UTC',
        intent: '훈련 목표',
        isPartial: false,
      },
    ],
    sessions: [],
  };
  const recovery = {
    title: '회복 본문',
    goal: '휴식 목표 전체',
    startDate: '2026-10-08',
    endDateExclusive: '2026-10-10',
    timezone: 'UTC',
    priority: 'normal',
    options: [
      {
        id,
        title: '전면 휴식',
        kind: 'full_rest',
        methodVersionId: null,
        explanation: '사용자가 선택한 휴식',
      },
    ],
    reassessment: [
      {
        id: candidateId,
        trigger: 'plan_changed',
        plannedAt: null,
        description: '다시 평가',
        policyVersion: null,
      },
    ],
  };
  const blueprint = {
    schemaVersion: 4,
    routineId: 'bp',
    versionId: 'bp-v1',
    title: '고정 루틴',
    intent: '확인',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: '확인 단계',
        content: { kind: 'checklist', prompt: '준비되었습니까?' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: 0,
    createdAt: stamp,
  };
  const schedule = {
    schemaVersion: 4,
    id,
    versionId: 'schedule-v1',
    blueprint: { id: 'bp', versionId: 'bp-v1' },
    window: {
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-10',
      timezone: 'UTC',
      maxOccurrences: 10,
    },
    rule: { kind: 'dates', dates: ['2026-10-08'], localTime: null },
    state: 'active',
  };
  const value = raceManualPublicPreviewSchema.parse({
    ...basePreview(),
    training: {
      state: 'present',
      members: [
        {
          aggregateId: id,
          before: { ref: { versionId: 'snapshot', version: 1 }, plan },
          after: { kind: 'retained', plan },
        },
      ],
    },
    recovery: {
      state: 'present',
      members: [
        {
          aggregateId: id,
          before: {
            ref: { versionId: candidateId, version: 1 },
            plan: recovery,
            status: 'user_confirmed',
            selectedOptionId: id,
            planLinks: [],
          },
          after: {
            kind: 'retained',
            plan: recovery,
            status: 'user_confirmed',
            selectedOptionId: id,
            planLinks: [],
          },
        },
      ],
    },
    routines: {
      state: 'present',
      members: [
        {
          aggregateId: id,
          blueprint,
          before: { schedule, expansion: { state: 'expanded', occurrences: [] } },
          after: { kind: 'retained', schedule, expansion: { state: 'expanded', occurrences: [] } },
          retainedStarted: [
            {
              runId: 'started',
              occurrenceId: 'occ-old',
              scheduleVersionId: 'old-schedule',
              blueprintVersionId: 'old-bp',
              anchorKey: 'anchor',
              preservation: 'started_run_frozen',
            },
          ],
        },
      ],
    },
    retainedUnplanned: [
      { runId: 'unplanned', blueprintVersionId: 'bp-v1', preservation: 'unplanned_run_unchanged' },
    ],
    notices: [
      { domain: 'routine_schedule', aggregateId: id, itemId: null, code: 'STARTED_RUN_PRESERVED' },
    ],
  });
  setup(value);
  await review();
  await screen.findByRole('checkbox');
  const preview = within(screen.getByLabelText('전체 계획 영향 미리보기'));
  expect(preview.getAllByText('훈련 본문')).toHaveLength(2);
  expect(preview.getAllByText('휴식 목표 전체')).toHaveLength(2);
  expect(preview.getByText('준비되었습니까?')).toBeInTheDocument();
  expect(preview.getByText(/started: 시작된 실행/)).toBeInTheDocument();
  expect(preview.getByText(/unplanned: 계획 밖 실행/)).toBeInTheDocument();
});
it('retains committed state if the Host refresh callback fails', async () => {
  const { request } = setup(undefined, {
    onCommitted: () => {
      throw Error('Refresh only');
    },
  });
  const user = await review();
  await screen.findByRole('checkbox');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: '계획 변경 승인' }));
  expect(
    await screen.findByText('서버 승인은 반영되었습니다. 화면 새로고침을 확인하세요.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '같은 승인 요청 다시 확인' }),
  ).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([r]) => r.path.endsWith('/approve'))).toHaveLength(1);
});

it('offers keyboard scroll controls outside the long preview body', async () => {
  setup();
  const user = await review();
  await screen.findByRole('checkbox');
  const body = screen.getByRole('region', { name: '미리보기 본문' });
  const scroll = vi.fn();
  Object.defineProperty(body, 'scrollBy', { value: scroll });
  const next = screen.getByRole('button', { name: '미리보기 아래로' });
  expect(body).not.toContainElement(next);
  next.focus();
  await user.keyboard('{Enter}');
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(next).toHaveFocus();
});

it('reports derived dirty/pending state and clears the Host guard on unmount', async () => {
  const onStateChange = vi.fn();
  const api = createRaceManualPublicApi({ request: vi.fn() });
  type ReviewResult = Awaited<ReturnType<typeof api.review>>;
  let resolve: ((value: ReviewResult) => void) | undefined;
  const { view } = setup(basePreview(), {
    onStateChange,
    api: {
      ...api,
      review: vi.fn(
        () =>
          new Promise<ReviewResult>((done) => {
            resolve = done;
          }),
      ),
    },
  });
  await waitFor(() =>
    expect(onStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false }),
  );
  await review();
  await waitFor(() =>
    expect(onStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: true }),
  );
  expect(resolve).toBeDefined();
  view.unmount();
  expect(onStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false });
});

it('clears dirty/pending only after the strict committed result, not preview success', async () => {
  const onStateChange = vi.fn();
  setup(basePreview(), { onStateChange });
  const user = await review();
  const checkbox = await screen.findByRole('checkbox');
  expect(onStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: false });
  await user.click(checkbox);
  await user.click(screen.getByRole('button', { name: '계획 변경 승인' }));
  await screen.findByText('날짜와 영향받는 계획의 승인이 서버에 반영되었습니다.');
  await waitFor(() =>
    expect(onStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false }),
  );
});

it('uses explicit transient impact without creating a review and invalidates it when intent changes', async () => {
  const { request } = setup(undefined, { impactSupport: 'supported' });
  request.mockImplementation(async () =>
    transportReplySchema.parse({
      status: 200,
      traceId: null,
      body: {
        schemaVersion: 1,
        status: 'projected',
        approvalAllowed: false,
        persistence: 'not_stored',
        freshness: 'not_checked',
        expectedEvent: { id, revision: 1 },
        intent: {
          expectedEvent: { id, revision: 1 },
          newLocalDate: '2026-10-09',
          selection: { kind: 'keep_plan' },
          resolutions: { nutrition: [], routines: [] },
        },
        beforeBasis: 'captured_snapshot',
        afterBasis: 'hypothetical',
        race: basePreview().race,
        training: { state: 'absent' },
        nutrition: { state: 'absent' },
        recovery: { state: 'absent' },
        routines: { state: 'absent' },
        retainedUnplanned: [],
        affected: [],
        resolutionRequirements: [],
        notices: [],
      },
    }),
  );
  await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.');
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-09' } });
  await userEvent.setup().selectOptions(screen.getByLabelText('계획 비교 방식'), 'keep_plan');
  await userEvent.setup().click(screen.getByRole('button', { name: '미저장 영향 보기' }));
  await screen.findByRole('heading', { name: '미저장 영향 · 고정된 변경 전과 가정한 변경 후' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0].path).toContain('/date-change-impact');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-10' } });
  expect(
    screen.queryByRole('heading', { name: '미저장 영향 · 고정된 변경 전과 가정한 변경 후' }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText('계획 비교 방식')).toHaveValue('keep_plan');
});

it('keeps diagnostic support separate and handles blocked diagnostics without a reference or auto-review', async () => {
  const { request } = setup(undefined, { impactSupport: 'supported' });
  request.mockResolvedValue(
    transportReplySchema.parse({
      status: 200,
      traceId: null,
      body: {
        schemaVersion: 1,
        status: 'blocked',
        reason: 'source_unavailable',
        domains: ['nutrition'],
        approvalAllowed: false,
        persistence: 'not_stored',
        freshness: 'not_checked',
      },
    }),
  );
  await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.');
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-09' } });
  await userEvent.setup().selectOptions(screen.getByLabelText('계획 비교 방식'), 'keep_plan');
  await userEvent.setup().click(screen.getByRole('button', { name: '미저장 영향 보기' }));
  await screen.findByText(/영향 진단 차단: source_unavailable/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByLabelText('새 대회 날짜')).toHaveValue('2026-10-09');
});
it('does not infer diagnostic capability from review support', async () => {
  const { request } = setup();
  await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.');
  expect(screen.queryByRole('button', { name: '미저장 영향 보기' })).not.toBeInTheDocument();
  expect(screen.getByText('미저장 영향 진단 지원을 확인할 수 없습니다.')).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
it('rediagnoses exact nutrition replacement before separate stored review with a new stable key', async () => {
  const { request } = setup(undefined, { impactSupport: 'supported' });
  const versionId = 'abcdefab-abcd-4abc-8abc-000000000009';
  const itemId = '식사-' + 'x'.repeat(201);
  const item = {
    id: itemId,
    category: 'before',
    title: '보존할 식사',
    anchor: { kind: 'absolute', date: '2026-10-09', localTime: null, timezone: 'UTC' },
    foods: [
      {
        foodVersionId: null,
        description: '영 수량',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
    ],
    targets: [],
    instructions: '보존',
  };
  const nutritionPlan = {
    period: { from: '2026-10-08', toInclusive: '2026-10-11' },
    purpose: '식사',
    timezone: 'UTC',
    items: [item],
  };
  request.mockImplementation(async (input) => {
    if (!input.path.endsWith('/date-change-impact'))
      return transportReplySchema.parse({
        status: 409,
        traceId: null,
        body: { status: 'blocked', stage: 'semantic' },
      });
    const body = input.body;
    const parsed = raceManualPublicPrepareSchema.parse(body);
    const r = parsed.intent.resolutions.nutrition[0];
    const unresolved = { state: 'unresolved', reason: 'missing_session_time' };
    return transportReplySchema.parse({
      status: 200,
      traceId: null,
      body: {
        schemaVersion: 1,
        status: 'projected',
        approvalAllowed: false,
        persistence: 'not_stored',
        freshness: 'not_checked',
        expectedEvent: { id, revision: 1 },
        intent: parsed.intent,
        beforeBasis: 'captured_snapshot',
        afterBasis: 'hypothetical',
        race: basePreview().race,
        training: { state: 'absent' },
        recovery: { state: 'absent' },
        routines: { state: 'absent' },
        retainedUnplanned: [],
        affected: [{ domain: 'nutrition', aggregateId: versionId }],
        resolutionRequirements: r
          ? []
          : [
              {
                domain: 'nutrition',
                aggregateId: versionId,
                planVersionId: versionId,
                itemId,
                reason: 'affected_timing_unresolved',
                editor: 'replace_anchor',
              },
            ],
        notices: [],
        nutrition: {
          state: 'present',
          members: [
            {
              aggregateId: versionId,
              before: {
                ref: { versionId, version: 1 },
                plan: nutritionPlan,
                linkedTraining: { kind: 'absent' },
              },
              after: {
                plan: r
                  ? { ...nutritionPlan, items: [{ ...item, anchor: r.anchor }] }
                  : nutritionPlan,
                linkedTraining: { kind: 'absent' },
              },
              timings: [
                {
                  itemId,
                  state: 'affected',
                  before: unresolved,
                  after: r
                    ? { state: 'resolved', date: '2026-10-09', localTime: '08:30', timezone: 'UTC' }
                    : unresolved,
                  resolution: r ? 'explicit_replacement' : 'absent',
                  requirement: r ? 'none' : 'resolve_before_review',
                },
              ],
            },
          ],
        },
      },
    });
  });
  await screen.findByText('현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.');
  fireEvent.change(screen.getByLabelText('새 대회 날짜'), { target: { value: '2026-10-09' } });
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('계획 비교 방식'), 'keep_plan');
  await user.click(screen.getByRole('button', { name: '미저장 영향 보기' }));
  await screen.findByLabelText(`영양 ${itemId} 날짜`);
  expect(screen.getByRole('button', { name: '전체 영향 검토' })).toBeDisabled();
  for (const [label, value] of [
    ['날짜', '2026-10-09'],
    ['시각', '08:30'],
    ['시간대', 'UTC'],
  ])
    fireEvent.change(screen.getByLabelText(`영양 ${itemId} ${label}`), { target: { value } });
  await user.click(screen.getByRole('button', { name: '해결 입력으로 다시 진단' }));
  await screen.findByText('영향받는 미해결 항목 없음. 저장 검토와 승인은 별도 동작입니다.');
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '전체 영향 검토' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '전체 영향 검토' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]?.[0].body).toEqual(request.mock.calls[1]?.[0].body);
  expect(request.mock.calls[2]?.[0].idempotencyKey).toBe('stable_request_0001');
  await screen.findByText(/검토를 준비할 수 없습니다 \(semantic\)/);
});
