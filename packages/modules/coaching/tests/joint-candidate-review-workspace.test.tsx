import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import { jointCandidateV3Schema } from '@workout/contracts/joint-coaching';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { JointCandidateReviewWorkspace } from '../src/joint-candidate-review-workspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const candidateId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const decisionId = '44444444-4444-4444-8444-444444444444';
const trainingVersionId = '55555555-5555-4555-8555-555555555555';
const nutritionPlanId = '66666666-6666-4666-8666-666666666666';
const nutritionVersionId = '77777777-7777-4777-8777-777777777777';
const itemId = '88888888-8888-4888-8888-888888888888';
const routineBefore = '99999999-9999-4999-8999-999999999999';
const routineAfter = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-09-18T00:00:00Z';

const session = {
  id: 'strength-session',
  blockId: 'block',
  date: '2026-09-20',
  localStartTime: '06:00',
  title: '기존 보강',
  sport: 'strength',
  durationSeconds: 1800,
  distanceMeters: null,
  targetRpe: null,
  purpose: '',
  notes: '',
  priority: 'normal',
  locks: { date: false, time: false, intensity: false },
  steps: [],
};
const before = planSnapshotSchema.parse({
  id: trainingVersionId,
  version: 1,
  createdAt: at,
  draft: {
    title: '기준 훈련',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index ? levels[index - 1] : null,
      level,
      title: level,
      startDate: '2026-09-18',
      endDateExclusive: '2026-10-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [session],
  },
});
const proposed = {
  ...before.draft,
  title: '새 훈련',
  sessions: [{ ...before.draft.sessions[0], date: '2026-09-21', title: '변경 보강' }],
};
const nutrition = nutritionPlanVersionSchema.parse({
  planId: nutritionPlanId,
  versionId: nutritionVersionId,
  version: 1,
  previousVersionId: null,
  approvedAt: at,
  approvalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  period: { from: '2026-09-18', toInclusive: '2026-09-30' },
  timezone: 'UTC',
  purpose: '보급',
  linkedTrainingPlanVersionId: trainingVersionId,
  items: [
    {
      id: itemId,
      planVersionId: nutritionVersionId,
      title: '운동 전 보급',
      category: 'before',
      anchor: {
        kind: 'relative',
        entity: 'session',
        entityId: 'strength-session',
        point: 'start',
        offsetMinutes: -30,
      },
      foods: [],
      targets: [],
      instructions: '준비',
      evidenceIds: [],
      source: 'user_confirmed',
    },
  ],
});
const basis = {
  schemaVersion: 3,
  domains: {
    scope: 'combined',
    training: {
      planVersionId: trainingVersionId,
      activityDataRevision: 2,
      exerciseCatalogRevision: 3,
    },
    nutrition: { planVersionId: nutritionVersionId, intakeDataRevision: 4, foodCatalogRevision: 5 },
  },
  contextDependencies: [{ kind: 'supplementary-set', id: 'set-1', revision: '3' }],
  preferenceRevision: 6,
  constraintRevision: 7,
  conversationRevision: 8,
  policyVersion: 'policy-v1',
  evidenceSnapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const candidate = jointCandidateV3Schema.parse({
  schemaVersion: 3,
  kind: 'joint-adjustment',
  id: candidateId,
  proposalId,
  decisionId,
  parentCandidateId: null,
  createdAt: at,
  digest: 'a'.repeat(64),
  basis,
  asOfLocalDate: '2026-09-18',
  nutritionPlanHeads: [{ planId: nutritionPlanId, versionId: nutritionVersionId }],
  writes: {
    scope: 'combined',
    training: {
      before,
      proposed,
      beforeSupplementaryLinks: [
        {
          schemaVersion: 2,
          plannedSessionId: 'strength-session',
          content: { kind: 'routine_version', routineVersionId: routineBefore },
        },
      ],
      supplementaryLinks: [
        {
          schemaVersion: 2,
          plannedSessionId: 'strength-session',
          content: { kind: 'routine_version', routineVersionId: routineAfter },
        },
      ],
    },
    nutrition: [
      {
        planId: nutritionPlanId,
        before: nutrition,
        proposed: {
          period: nutrition.period,
          timezone: nutrition.timezone,
          purpose: nutrition.purpose,
          linkedTrainingPlanVersionId: nutrition.linkedTrainingPlanVersionId,
          items: nutrition.items.map(({ planVersionId: _planVersionId, ...item }) => item),
        },
      },
    ],
  },
  diff: {
    definitionVersion: 'joint-candidate-diff-v3',
    training: { titleChanged: true, periodIds: [], sessionIds: ['strength-session'] },
    nutrition: [{ planId: nutritionPlanId, itemIds: [], metadataChanged: false }],
    relativeImpacts: [
      {
        planId: nutritionPlanId,
        itemId,
        sessionId: 'strength-session',
        point: 'start',
        resolution: 'requires_reprojection',
      },
    ],
  },
  validation: {
    definitionVersion: 'joint-candidate-validation-v3',
    status: 'checked',
    errors: [],
    warnings: [],
    unknowns: [],
  },
});
const child = jointCandidateV3Schema.parse({
  ...candidate,
  id: childId,
  parentCandidateId: candidateId,
  digest: 'b'.repeat(64),
});
const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ body, status, traceId: null });

function setup(
  behavior: {
    approval?: 'lost-once' | 'conflict';
    partial?: 'lost-once';
    online?: boolean;
    candidate?: typeof candidate;
    revokedAfterFirstRead?: boolean;
  } = {},
) {
  const writes: TransportRequest[] = [];
  let approvalCount = 0;
  let partialCount = 0;
  let candidateReadCount = 0;
  const transport: AuthenticatedTransport = {
    async request(input) {
      if (input.method === 'GET' && input.path === `/bff/v1/joint-candidates/${candidateId}`) {
        candidateReadCount += 1;
        if (behavior.revokedAfterFirstRead && candidateReadCount > 1)
          return reply({ error: { code: 'CANDIDATE_UNAVAILABLE' } }, 404);
        return reply(behavior.candidate ?? candidate);
      }
      if (input.method === 'GET' && input.path === `/bff/v1/joint-candidates/${childId}`)
        return reply(child);
      if (input.method === 'POST') {
        writes.push(input);
        if (input.path.endsWith('/partials')) {
          partialCount += 1;
          if (behavior.partial === 'lost-once' && partialCount === 1)
            throw new Error('LOST_RESPONSE');
          return reply(child);
        }
        if (input.path.endsWith('/approve')) {
          approvalCount += 1;
          if (behavior.approval === 'lost-once' && approvalCount === 1)
            throw new Error('LOST_RESPONSE');
          if (behavior.approval === 'conflict')
            return reply({ error: { code: 'STALE_BASIS' } }, 409);
          return reply({ training: before, nutrition: [nutrition] });
        }
      }
      throw new Error(`UNEXPECTED_REQUEST:${input.method}:${input.path}`);
    },
  };
  if (behavior.online !== undefined)
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(behavior.online);
  const user = userEvent.setup();
  render(
    <JointCandidateReviewWorkspace
      athleteId="athlete-1"
      sessionId="session-1"
      candidateId={candidateId}
      transport={transport}
      createId={() => 'stable_key_001'}
    />,
  );
  return { user, writes };
}

describe('joint candidate review', () => {
  it('removes a revoked candidate from view and the query cache after revalidation', async () => {
    const { user } = setup({ revokedAfterFirstRead: true });
    expect(await screen.findByText(/훈련 제목: 기준 훈련/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '후보 다시 조회' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /후보가 회수되었거나 접근할 수 없습니다/,
    );
    expect(screen.queryByText(/훈련 제목: 기준 훈련/)).toBeNull();
    expect(screen.queryByRole('button', { name: /전체 승인/ })).toBeNull();
  });

  it('shows basis, nutrition relative impacts and frozen supplementary content before confirmation', async () => {
    setup();
    expect(await screen.findByText(/훈련 제목: 기준 훈련/)).toBeTruthy();
    expect(screen.getByText(/영양 항목 88888888/)).toBeTruthy();
    expect(screen.getByText(/고정 루틴 버전 99999999/)).toBeTruthy();
    expect(screen.getByText(/근거 스냅샷 cccccccc/)).toBeTruthy();
    expect(screen.getByText(/검증 checked/)).toBeTruthy();
    expect(screen.getByText(/기존 보강 · 2026-09-20 06:00/)).toBeTruthy();
    expect(screen.getByText(/변경 보강 · 2026-09-21 06:00/)).toBeTruthy();
    expect(screen.getByText(/supplementary-set set-1 · 개정 3/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`기준 버전 ${nutritionVersionId}`))).toBeTruthy();
    expect(screen.getByRole('button', { name: '이 후보 전체 승인' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('creates a partial child and requires a fresh explicit review of the child before approval', async () => {
    const { user, writes } = setup();
    await screen.findByText(/훈련 제목: 기준 훈련/);
    await user.click(screen.getByRole('checkbox', { name: '세션 strength-session' }));
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    await user.click(screen.getByRole('button', { name: '선택으로 새 후보 만들기' }));
    expect(await screen.findByText(/새 후보를 다시 검토하고 확인하세요/)).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: `/bff/v1/joint-candidates/${candidateId}/partials`,
      idempotencyKey: 'stable_key_001',
      body: {
        selection: {
          trainingSessionIds: ['strength-session'],
          includeTrainingTitle: false,
          trainingPeriodIds: [],
          nutritionPlanIds: [],
        },
      },
    });
    await screen.findByText(new RegExp(`부분 선택으로 새로 만든 후보 · 원본 ${candidateId}`));
    expect(screen.getByRole('button', { name: '이 후보 전체 승인' }).hasAttribute('disabled')).toBe(
      true,
    );
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    await user.click(screen.getByRole('button', { name: '이 후보 전체 승인' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.path).toBe(`/bff/v1/joint-candidates/${childId}/approve`);
    expect(writes[1]?.body).toMatchObject({
      candidateId: childId,
      proposalDigest: child.digest,
      expectedBasis: child.basis,
    });
    expect(await screen.findByText(/적용 완료/)).toBeTruthy();
  });

  it('retries an uncertain approval with exactly the original key and body', async () => {
    const { user, writes } = setup({ approval: 'lost-once' });
    await screen.findByText(/훈련 제목: 기준 훈련/);
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    await user.click(screen.getByRole('button', { name: '이 후보 전체 승인' }));
    expect(await screen.findByRole('button', { name: '같은 요청 재시도' })).toBeTruthy();
    expect(screen.queryByText(/적용 완료/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '같은 요청 재시도' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(await screen.findByText(/적용 완료/)).toBeTruthy();
  });

  it('retries partial candidate creation with the same selection and key after response loss', async () => {
    const { user, writes } = setup({ partial: 'lost-once' });
    await screen.findByText(/훈련 제목: 기준 훈련/);
    await user.click(screen.getByRole('checkbox', { name: '세션 strength-session' }));
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    await user.click(screen.getByRole('button', { name: '선택으로 새 후보 만들기' }));
    expect(await screen.findByRole('button', { name: '같은 요청 재시도' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '같은 요청 재시도' }));
    await screen.findByText(new RegExp(`부분 선택으로 새로 만든 후보 · 원본 ${candidateId}`));
    expect(writes).toHaveLength(2);
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(screen.getByRole('button', { name: '이 후보 전체 승인' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('keeps a stale conflict unapproved', async () => {
    const { user, writes } = setup({ approval: 'conflict' });
    await screen.findByText(/훈련 제목: 기준 훈련/);
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    await user.click(screen.getByRole('button', { name: '이 후보 전체 승인' }));
    expect(await screen.findByText(/기준이 변경됐거나 요청이 거절됐습니다/)).toBeTruthy();
    expect(screen.queryByText(/적용 완료/)).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it('does not send or claim success while offline', async () => {
    const { user, writes } = setup({ online: false });
    await screen.findByText(/훈련 제목: 기준 훈련/);
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    await user.click(screen.getByRole('button', { name: '이 후보 전체 승인' }));
    expect(await screen.findByText(/오프라인입니다/)).toBeTruthy();
    expect(writes).toHaveLength(0);
    expect(screen.queryByText(/적용 완료/)).toBeNull();
  });

  it('does not approve a candidate with unresolved validation', async () => {
    const unresolved = jointCandidateV3Schema.parse({
      ...candidate,
      validation: {
        ...candidate.validation,
        status: 'uncertain',
        unknowns: [
          {
            code: 'RELATIVE_ANCHOR_UNRESOLVED',
            subject: { kind: 'nutrition_item', id: itemId },
          },
        ],
      },
    });
    const { user, writes } = setup({ candidate: unresolved });
    await screen.findByText(/검증 uncertain/);
    await user.click(screen.getByRole('checkbox', { name: /이 후보의 훈련·영양 변경/ }));
    expect(screen.getByText(/RELATIVE_ANCHOR_UNRESOLVED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '이 후보 전체 승인' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(writes).toHaveLength(0);
  });
});
