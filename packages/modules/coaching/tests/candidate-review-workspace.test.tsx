import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { trainingCandidateBundleV1Schema } from '@workout/contracts/coaching-candidates';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { CandidateReviewWorkspace } from '../src/candidate-review-workspace';

afterEach(cleanup);
const candidateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const planId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const proposalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const decisionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const at = '2026-09-18T00:00:00Z';
const session = {
  id: 'session-a',
  blockId: 'block',
  date: '2026-09-19',
  localStartTime: null,
  title: '원래 달리기',
  sport: 'running',
  durationSeconds: 3600,
  distanceMeters: 10000,
  targetRpe: null,
  purpose: '',
  notes: '',
  priority: 'normal',
  locks: { date: false, time: false, intensity: false },
  steps: [],
};
const changed = { ...session, date: '2026-09-20', title: '조정한 달리기', durationSeconds: 3900 };
const draft = {
  title: '원래 계획',
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : levels[index - 1],
    level,
    title: level,
    startDate: '2026-09-18',
    endDateExclusive: '2026-09-23',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [session],
};
const original = planSnapshotSchema.parse({ id: planId, version: 1, createdAt: at, draft });
const applied = planSnapshotSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  version: 2,
  createdAt: at,
  draft: { ...draft, title: '조정한 계획', sessions: [changed] },
});
const strategy = {
  summary: '다음 달리기 조정',
  preservedIntent: '달리기 목적 유지',
  rationale: '합성 활동 후 검토',
  unconfirmedInformation: [],
  revisitWhen: '승인 전',
};
const basis = {
  schemaVersion: 1,
  scope: 'running-core-v2-training',
  athleteId: 'owner',
  evidenceSnapshotId: '22222222-2222-4222-8222-222222222222',
  threadId: '33333333-3333-4333-8333-333333333333',
  conversationRevision: 1,
  planVersionId: planId,
  dependencies: {
    schemaVersion: 2,
    scope: 'core-ledgers-v2',
    athleteId: 'owner',
    capturedAt: at,
    trainingPlan: { kind: 'exists', versionId: planId },
    activities: { count: '0', revisionSum: '0' },
    checkIns: { kind: 'absent' },
    sessionCompletions: { kind: 'absent' },
    userConstraints: { kind: 'absent' },
    aiConsent: { kind: 'exists', revision: 1, granted: true },
  },
  policy: { id: 'synthetic-policy', version: '1' },
  retrieval: { kind: 'none' },
};
const bundle = trainingCandidateBundleV1Schema.parse({
  decision: {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    id: decisionId,
    runId,
    basis,
    strategy,
    createdAt: at,
  },
  proposal: {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    id: proposalId,
    runId,
    decisionId,
    candidateIds: [candidateId],
    createdAt: at,
  },
  candidate: {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    id: candidateId,
    proposalId,
    decisionId,
    runId,
    createdAt: at,
    digest: 'a'.repeat(64),
    basis,
    before: original,
    proposed: { ...draft, title: '조정한 계획', sessions: [changed] },
    asOfLocalDate: '2026-09-18',
    strategy,
    diff: {
      definitionVersion: 'training-candidate-diff-v1',
      title: { before: '원래 계획', after: '조정한 계획' },
      periodChanges: [],
      sessionChanges: [{ id: session.id, kind: 'modified', before: session, after: changed }],
      duration: {
        before: { unit: 's', knownMin: 3600, knownMax: 3600, unknownSessionIds: [] },
        after: { unit: 's', knownMin: 3900, knownMax: 3900, unknownSessionIds: [] },
        delta: { unit: 's', min: 300, max: 300 },
      },
      distance: {
        before: { unit: 'm', knownMin: 10000, knownMax: 10000, unknownSessionIds: [] },
        after: { unit: 'm', knownMin: 10000, knownMax: 10000, unknownSessionIds: [] },
        delta: { unit: 'm', min: 0, max: 0 },
      },
    },
    validation: {
      definitionVersion: 'training-candidate-validation-v1',
      status: 'checked',
      errors: [],
      warnings: [],
      unknowns: [],
    },
  },
});
const uncertainBundle = trainingCandidateBundleV1Schema.parse({
  ...bundle,
  candidate: {
    ...bundle.candidate,
    validation: {
      definitionVersion: 'training-candidate-validation-v1',
      status: 'uncertain',
      errors: [],
      warnings: [],
      unknowns: [{ code: 'TARGET_UNKNOWN', subject: { kind: 'session', id: 'session-a' } }],
    },
  },
});
const peerBundle = trainingCandidateBundleV1Schema.parse({
  ...bundle,
  proposal: { ...bundle.proposal, candidateIds: [candidateId, childId] },
  candidate: {
    ...bundle.candidate,
    id: childId,
    strategy: { ...bundle.candidate.strategy, summary: '다른 일정 조정' },
  },
});
const reply = (body: unknown, status = 200) =>
  transportReplySchema.parse({ body, status, traceId: null });

function setup(candidateBundle = bundle, withPeer = false) {
  let status: 'current' | 'stale' | 'withdrawn' = 'current';
  let head = original;
  let failApprovalOnce: 'network' | 'conflict' | null = null;
  const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) => {
    if (input.method === 'GET' && input.path.endsWith('/status'))
      return reply({ schemaVersion: 1, candidateId, kind: status });
    if (input.method === 'GET' && input.path === '/bff/v1/plans/current')
      return reply({ head, history: [] });
    if (input.method === 'GET' && input.path === `/bff/v1/coaching-candidates/${candidateId}`)
      return reply(candidateBundle);
    if (input.method === 'GET' && input.path.endsWith('/candidates'))
      return reply(withPeer ? [candidateBundle, peerBundle] : [candidateBundle]);
    if (input.method === 'POST' && input.path.endsWith('/partials'))
      return reply({
        ...bundle,
        proposal: { ...bundle.proposal, candidateIds: [childId] },
        candidate: { ...bundle.candidate, id: childId, parentCandidateId: candidateId },
      });
    if (input.method === 'POST' && input.path.endsWith('/approve')) {
      if (failApprovalOnce === 'network') {
        failApprovalOnce = null;
        throw new Error('lost response');
      }
      if (failApprovalOnce === 'conflict') {
        failApprovalOnce = null;
        status = 'stale';
        return reply({ error: { code: 'CANDIDATE_NOT_APPROVABLE' } }, 409);
      }
      head = applied;
      status = 'stale';
      return reply(applied);
    }
    throw new Error(`Unexpected ${input.method} ${input.path}`);
  });
  const props = {
    athleteId: 'owner',
    sessionId: 'session',
    candidateId,
    transport: { request },
    createId: () => 'stable-key',
  };
  const view = render(<CandidateReviewWorkspace {...props} />);
  return {
    request,
    props,
    ...view,
    setStatus(value: 'current' | 'stale' | 'withdrawn') {
      status = value;
    },
    setHead(value: typeof original) {
      head = value;
    },
    loseApprovalResponse() {
      failApprovalOnce = 'network';
    },
    conflictOnApproval() {
      failApprovalOnce = 'conflict';
    },
  };
}

describe('candidate review workspace', () => {
  it('shows original and proposed dates, issues and impacts, requiring explicit confirmation before approval', async () => {
    const app = setup();
    const calendar = await screen.findByRole('table', { name: '영향받는 날짜별 원안과 제안' });
    expect(within(calendar).getByText('2026-09-19')).toBeInTheDocument();
    expect(within(calendar).getByText('2026-09-20')).toBeInTheDocument();
    expect(screen.getByText(/변화량 300s/)).toBeInTheDocument();
    const detail = screen.getAllByText('세션 세부 내용')[0];
    if (!detail) throw new Error('Missing session comparison');
    await userEvent.click(detail);
    expect(detail?.closest('details')).toHaveAttribute('open');
    expect(screen.getAllByText('강도').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '확인하고 계획에 적용' })).toBeDisabled();
    expect(app.request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(0);
    await userEvent.click(screen.getByRole('checkbox', { name: /원안과 제안/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인하고 계획에 적용' }));
    await screen.findByText(/서버에서 적용한 계획 버전 2/);
    await screen.findByText(/이 후보는 오래되었습니다/);
    expect(screen.queryByRole('region', { name: '후보 요약' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '저장된 계획 보기' })).toHaveAttribute(
      'href',
      '/planner',
    );
    const write = app.request.mock.calls.find(([input]) => input.path.endsWith('/approve'))?.[0];
    expect(write).toMatchObject({
      method: 'POST',
      idempotencyKey: 'stable-key',
      body: { schemaVersion: 1, expectedDigest: 'a'.repeat(64), confirmed: true },
    });
    expect(write?.body).not.toHaveProperty('proposed');
  });

  it('creates a new candidate from selected diff identifiers without changing the plan', async () => {
    const app = setup();
    await screen.findByRole('table', { name: '변경 전후 세부 항목' });
    expect(screen.getByRole('button', { name: '선택한 변경으로 새 후보 만들기' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /세션 session-a/ }));
    await userEvent.click(screen.getByRole('button', { name: '선택한 변경으로 새 후보 만들기' }));
    expect(await screen.findByRole('link', { name: '새로 검증한 후보 검토' })).toHaveAttribute(
      'href',
      `/proposals/${childId}`,
    );
    const write = app.request.mock.calls.find(([input]) => input.path.endsWith('/partials'))?.[0];
    expect(write).toMatchObject({
      method: 'POST',
      idempotencyKey: 'stable-key',
      body: { schemaVersion: 1, sessionIds: ['session-a'], periodIds: [], includeTitle: false },
    });
    expect(
      app.request.mock.calls.filter(([input]) => input.path.endsWith('/approve')),
    ).toHaveLength(0);
  });

  it('hides stale candidate body and disables approval when server status changes', async () => {
    const app = setup();
    await screen.findByRole('table', { name: '변경 전후 세부 항목' });
    app.setStatus('stale');
    await userEvent.click(screen.getByRole('button', { name: '최신 상태 확인' }));
    expect(await screen.findByText(/이 후보는 오래되었습니다/)).toBeInTheDocument();
    expect(screen.queryByText('다음 달리기 조정')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '확인하고 계획에 적용' })).not.toBeInTheDocument();
    expect(app.request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(0);
  });

  it('retains the exact approval request after an uncertain response and clears it on account change', async () => {
    const app = setup();
    app.loseApprovalResponse();
    await screen.findByRole('table', { name: '변경 전후 세부 항목' });
    await userEvent.click(screen.getByRole('checkbox', { name: /원안과 제안/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인하고 계획에 적용' }));
    await screen.findByRole('button', { name: '같은 요청으로 결과 재확인' });
    expect(screen.getByRole('checkbox', { name: /원안과 제안/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '같은 요청으로 결과 재확인' }));
    await screen.findByText(/서버에서 적용한 계획 버전 2/);
    const writes = app.request.mock.calls.filter(([input]) => input.path.endsWith('/approve'));
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toEqual(writes[1]?.[0]);
    app.rerender(
      <CandidateReviewWorkspace {...app.props} athleteId="another" sessionId="another" />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/서버에서 적용한 계획 버전 2/)).not.toBeInTheDocument(),
    );
  });

  it('hides candidate body when the plan head changes while candidate status remains current', async () => {
    const app = setup();
    await screen.findByRole('table', { name: '변경 전후 세부 항목' });
    app.setHead(applied);
    await userEvent.click(screen.getByRole('button', { name: '최신 상태 확인' }));
    await screen.findByText(/현재 계획이 후보의 기준 버전과 다릅니다/);
    expect(screen.queryByRole('region', { name: '후보 요약' })).not.toBeInTheDocument();
    expect(screen.queryByText('다음 달리기 조정')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '변경 전후 세부 항목' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '확인하고 계획에 적용' })).not.toBeInTheDocument();
    expect(screen.queryByText(/이 후보는 오래되었습니다/)).not.toBeInTheDocument();
    expect(app.request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(0);
  });

  it('renders validation unknowns and prevents explicit approval', async () => {
    const app = setup(uncertainBundle);
    expect(await screen.findByText(/TARGET_UNKNOWN/)).toBeInTheDocument();
    expect(screen.getByText(/오류 또는 미확인 항목이 있어/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '확인하고 계획에 적용' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /세션 session-a/ }));
    expect(screen.getByRole('button', { name: '선택한 변경으로 새 후보 만들기' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '선택한 변경으로 새 후보 만들기' }));
    expect(await screen.findByRole('link', { name: '새로 검증한 후보 검토' })).toBeInTheDocument();
    expect(
      app.request.mock.calls.filter(([input]) => input.path.endsWith('/approve')),
    ).toHaveLength(0);
  });

  it('shows actual peer candidates without creating placeholder options', async () => {
    setup(bundle, true);
    const peers = await screen.findByRole('navigation', { name: '같은 실행의 다른 후보' });
    expect(peers).toHaveTextContent('현재 후보 1 · 다음 달리기 조정');
    expect(screen.getByRole('link', { name: '후보 2 · 다른 일정 조정' })).toHaveAttribute(
      'href',
      `/proposals/${childId}`,
    );
    expect(peers.querySelectorAll('li')).toHaveLength(2);
  });

  it('treats a server conflict as stale and does not offer uncertain replay', async () => {
    const app = setup();
    app.conflictOnApproval();
    await screen.findByRole('table', { name: '변경 전후 세부 항목' });
    await userEvent.click(screen.getByRole('checkbox', { name: /원안과 제안/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인하고 계획에 적용' }));
    expect(await screen.findByText(/이 후보는 오래되었습니다/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '같은 요청으로 결과 재확인' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/서버에서 적용한 계획 버전 2/)).not.toBeInTheDocument();
    expect(
      app.request.mock.calls.filter(([input]) => input.path.endsWith('/approve')),
    ).toHaveLength(1);
  });
});
