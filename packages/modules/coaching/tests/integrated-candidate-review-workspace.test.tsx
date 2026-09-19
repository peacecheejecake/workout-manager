import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
  type IntegratedCandidateV4,
} from '@workout/contracts/integrated-coaching';
import { IntegratedCandidateReviewWorkspace } from '../src/integrated-candidate-review-workspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const candidateId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const trainingId = '33333333-3333-4333-8333-333333333333';
const nutritionId = '44444444-4444-4444-8444-444444444444';
const recoveryId = '55555555-5555-4555-8555-555555555555';
const scheduleId = '66666666-6666-4666-8666-666666666666';
const trainingVersionId = '77777777-7777-4777-8777-777777777777';
const recoveryVersionId = '88888888-8888-4888-8888-888888888888';
const scheduleVersionId = '99999999-9999-4999-8999-999999999999';
const blueprintId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const blueprintVersionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const recoveryOptionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const reassessmentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const occurrenceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const approvalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const nutritionVersionId = '12121212-1212-4212-8212-121212121212';
const appliedRecoveryVersionId = '13131313-1313-4313-8313-131313131313';

const candidate = integratedCandidateV4Schema.parse({
  schemaVersion: 4,
  id: candidateId,
  proposalId,
  digest: 'a'.repeat(64),
  basis: {
    schemaVersion: 4,
    planHeads: [
      {
        domain: 'training',
        aggregateId: trainingId,
        head: { kind: 'exists', versionId: trainingVersionId },
      },
      { domain: 'nutrition', aggregateId: nutritionId, head: { kind: 'absent' } },
      {
        domain: 'recovery',
        aggregateId: recoveryId,
        head: { kind: 'exists', versionId: recoveryVersionId },
      },
      { domain: 'routine_schedule', aggregateId: scheduleId, head: { kind: 'absent' } },
    ],
    contextDependencies: [{ kind: 'routine-run-head', id: 'morning-routine', revision: '3' }],
    preferenceRevision: 1,
    constraintRevision: 2,
    conversationRevision: 3,
    policyVersion: 'policy-v4',
    evidenceSnapshotId: 'evidence-snapshot-1',
  },
  writes: [
    {
      domain: 'training',
      aggregateId: trainingId,
      proposed: {
        timezone: 'UTC',
        title: '통합 훈련 계획',
        periods: [
          {
            id: 'season-1',
            parentId: null,
            level: 'season',
            title: '가을 시즌',
            startDate: '2026-09-19',
            endDateExclusive: '2026-10-01',
            timezone: 'UTC',
            intent: '일관성',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    },
    {
      domain: 'nutrition',
      aggregateId: nutritionId,
      proposed: {
        period: { from: '2026-09-19', toInclusive: '2026-09-30' },
        timezone: 'UTC',
        purpose: '훈련 보급',
        linkedTrainingPlanVersionId: null,
        items: [],
      },
    },
    {
      domain: 'recovery',
      aggregateId: recoveryId,
      selectedOptionId: recoveryOptionId,
      proposed: {
        title: '회복 전략',
        goal: '다음 훈련 전 회복',
        startDate: '2026-09-19',
        endDateExclusive: '2026-09-21',
        timezone: 'UTC',
        knownFacts: [],
        missingInformation: [],
        priority: 'normal',
        observations: [],
        planRefs: [],
        options: [
          {
            id: recoveryOptionId,
            title: '완전 휴식',
            kind: 'full_rest',
            methodVersionId: null,
            explanation: '추가 운동 없이 회복합니다.',
          },
        ],
        reassessment: [
          {
            id: reassessmentId,
            trigger: 'plan_changed',
            plannedAt: null,
            description: '계획이 바뀌면 다시 확인',
            policyVersion: null,
          },
        ],
      },
    },
    {
      domain: 'routine_schedule',
      aggregateId: scheduleId,
      sourcePlanVersionId: null,
      proposed: {
        schemaVersion: 4,
        id: scheduleId,
        versionId: scheduleVersionId,
        blueprint: { id: blueprintId, versionId: blueprintVersionId },
        window: {
          startDate: '2026-09-19',
          endDateExclusive: '2026-09-20',
          timezone: 'UTC',
          maxOccurrences: 1,
        },
        rule: { kind: 'dates', dates: ['2026-09-19'], localTime: '08:00' },
        state: 'active',
      },
      occurrences: [
        {
          id: occurrenceId,
          schedule: { id: scheduleId, versionId: scheduleVersionId },
          blueprint: { id: blueprintId, versionId: blueprintVersionId },
          anchorKey: 'date:2026-09-19',
          scheduledAt: '2026-09-19T08:00:00.000Z',
          timingStatus: 'resolved',
          stepBindings: [],
          selectedChoices: {},
        },
      ],
    },
  ],
  summary: '훈련, 영양, 회복, 루틴 일정을 함께 조정합니다.',
  validation: { status: 'checked', errors: [], unknowns: [] },
  createdAt: '2026-09-19T00:00:00.000Z',
});

const result = integratedApprovalResultV4Schema.parse({
  schemaVersion: 4,
  approvalId,
  candidateId,
  versions: [
    { domain: 'training', aggregateId: trainingId, versionId: trainingVersionId },
    { domain: 'nutrition', aggregateId: nutritionId, versionId: nutritionVersionId },
    { domain: 'recovery', aggregateId: recoveryId, versionId: appliedRecoveryVersionId },
    { domain: 'routine_schedule', aggregateId: scheduleId, versionId: scheduleVersionId },
  ],
  occurrenceIds: [occurrenceId],
  approvedAt: '2026-09-19T00:01:00.000Z',
});

const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ body, status, traceId: null });

function setup(
  behavior: {
    candidate?: IntegratedCandidateV4;
    unsupported?: boolean;
    approval?: 'lost-once';
  } = {},
) {
  const writes: TransportRequest[] = [];
  let approvalCount = 0;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (
        input.method === 'GET' &&
        input.path === `/bff/v1/integrated-candidates/${candidateId}?maxSchemaVersion=4`
      ) {
        if (behavior.unsupported)
          return reply({ error: { code: 'UNSUPPORTED_SCHEMA_VERSION' } }, 409);
        return reply(behavior.candidate ?? candidate);
      }
      if (
        input.method === 'POST' &&
        input.path === `/bff/v1/integrated-candidates/${candidateId}/approve`
      ) {
        writes.push(input);
        approvalCount += 1;
        if (behavior.approval === 'lost-once' && approvalCount === 1)
          throw new Error('LOST_RESPONSE');
        return reply(result);
      }
      throw new Error(`UNEXPECTED_REQUEST:${input.method}:${input.path}`);
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const user = userEvent.setup();
  render(
    <IntegratedCandidateReviewWorkspace
      athleteId="athlete-1"
      sessionId="session-1"
      candidateId={candidateId}
      transport={transport}
      queryClient={client}
    />,
  );
  return { client, invalidate, user, writes };
}

describe('integrated candidate review workspace', () => {
  it('shows all four writes, exists and absent heads, dependencies, and validation state', async () => {
    setup();

    const writes = await screen.findByRole('region', { name: '네 도메인 변경' });
    expect(within(writes).getByText('훈련', { selector: 'strong' })).toBeTruthy();
    expect(within(writes).getByText('영양', { selector: 'strong' })).toBeTruthy();
    expect(within(writes).getByText('회복', { selector: 'strong' })).toBeTruthy();
    expect(within(writes).getByText('루틴 일정', { selector: 'strong' })).toBeTruthy();

    const heads = screen.getByRole('region', { name: '계획 head 기준' });
    expect(within(heads).getAllByText(/기존 버전/)).toHaveLength(2);
    expect(within(heads).getAllByText(/기존 head 없음/)).toHaveLength(2);

    const validation = screen.getByRole('region', { name: '읽기 의존성과 검증' });
    expect(within(validation).getByText(/검증 checked · 오류 0건 · 미확인 0건/)).toBeTruthy();
    expect(
      within(validation).getByText(/routine-run-head · morning-routine · 개정 3/),
    ).toBeTruthy();
  });

  it('shows update guidance and blocks approval for an unsupported schema response', async () => {
    const { writes } = setup({ unsupported: true });

    expect(await screen.findByRole('alert')).toHaveTextContent('앱을 업데이트');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '네 도메인 변경 승인' })).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it('requires explicit confirmation, posts without a body key, and invalidates related queries', async () => {
    const { invalidate, user, writes } = setup();
    const approve = await screen.findByRole('button', { name: '네 도메인 변경 승인' });
    expect(approve).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', {
        name: '이 후보의 훈련·영양·회복·루틴 일정 변경과 근거를 확인했습니다.',
      }),
    );
    expect(approve).toBeEnabled();
    await user.click(approve);

    expect(
      await screen.findByText(/서버에서 네 도메인 계획의 원자적 적용을 확인했습니다/),
    ).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(writes[0]?.body).toMatchObject({
      schemaVersion: 4,
      confirmed: true,
      proposalId,
      candidateId,
      writeDomains: ['training', 'nutrition', 'recovery', 'routine_schedule'],
    });
    expect(writes[0]?.body).not.toHaveProperty('idempotencyKey');

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['users', 'athlete-1', 'sessions', 'session-1', 'integrated-candidate-v4'],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['users', 'athlete-1', 'sessions', 'session-1', 'coaching'],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['planning', 'athlete-1', 'session-1'],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['integrated-planner', 'athlete-1', 'session-1'],
      });
    });
  });

  it('retries an ambiguous approval with the exact same body and idempotency key', async () => {
    const { user, writes } = setup({ approval: 'lost-once' });
    await screen.findByRole('region', { name: '네 도메인 변경' });
    await user.click(
      screen.getByRole('checkbox', {
        name: '이 후보의 훈련·영양·회복·루틴 일정 변경과 근거를 확인했습니다.',
      }),
    );
    await user.click(screen.getByRole('button', { name: '네 도메인 변경 승인' }));

    expect(await screen.findByRole('button', { name: '같은 요청 재시도' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '같은 요청 재시도' }));
    expect(
      await screen.findByText(/서버에서 네 도메인 계획의 원자적 적용을 확인했습니다/),
    ).toBeTruthy();

    expect(writes).toHaveLength(2);
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
  });

  it('displays validation errors and unknowns and keeps approval disabled', async () => {
    const blockedCandidate = integratedCandidateV4Schema.parse({
      ...candidate,
      validation: {
        status: 'blocked',
        errors: ['훈련 계획 기간이 겹칩니다.'],
        unknowns: ['회복 기록 최신 여부를 확인할 수 없습니다.'],
      },
    });
    setup({ candidate: blockedCandidate });

    expect(await screen.findByText('훈련 계획 기간이 겹칩니다.')).toBeTruthy();
    expect(screen.getByText('회복 기록 최신 여부를 확인할 수 없습니다.')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '네 도메인 변경 승인' })).toBeDisabled();
  });
});
