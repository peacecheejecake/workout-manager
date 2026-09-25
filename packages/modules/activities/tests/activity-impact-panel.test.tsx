import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityContextSchema } from '@workout/contracts/activity-context';
import type { TransportRequest } from '@workout/contracts/core';
import { ActivityImpactPanel } from '../src/activity-impact-panel';
import { ClassificationItem } from '../src/impact-classification';

/**
 * S09 impact split (M2-01k-m, 01 §7.2, V2-F14): three sections with their own heading and
 * source line; a classification never without source, version and uncertainty; no risk %,
 * causal number or contribution share anywhere; the consultation section only reads.
 */
const version = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const values = {
  title: '관측 활동',
  kind: 'running',
  startedAt: '2026-09-16T00:00:00Z',
  timezone: 'Asia/Seoul',
  durationSeconds: 600,
  durationKind: 'timer',
  distanceMeters: 4200,
};
const activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 2,
  source: { kind: 'manual', sourceId: 'manual-one', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
  userReport: {
    sessionRpe: 7,
    note: null,
    planLink: { planVersionId: version, sessionId: 'session' },
    source: 'user',
    method: 'self_report',
    definitionVersion: 'activity-report-v1',
    rpeReportedAt: '2026-09-16T01:00:00Z',
  },
};
const metric = { value: null, knownCount: 0, missingCount: 0 };
const envelope = {
  definitionVersion: 'activity-context-v1',
  observedAt: '2026-09-16T01:00:00Z',
  activity,
  activityDataRevision: { count: 2, revisionSum: '3' },
};
function linked(session: Record<string, unknown> = {}) {
  return activityContextSchema.parse({
    ...envelope,
    planContext: {
      status: 'linked',
      planVersion: { id: version, version: 3, title: '저장된 계획' },
      currentPlanVersionId: version,
      session: {
        id: 'session',
        blockId: 'block',
        date: '2026-09-16',
        localStartTime: null,
        title: '계획 달리기',
        sport: 'running',
        durationSeconds: 600,
        distanceMeters: 5000,
        targetRpe: 5,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
        ...session,
      },
      block: {
        id: 'block',
        parentId: 'phase',
        level: 'block',
        title: '연결 Block',
        startDate: '2026-09-01',
        endDateExclusive: '2026-09-20',
        timezone: 'Asia/Seoul',
        intent: '',
        isPartial: false,
      },
      actualLocalDate: '2026-09-16',
      blockMembership: 'included',
      blockActual: {
        count: 2,
        distanceMeters: { value: 4200, knownCount: 1, missingCount: 1 },
        durationSeconds: {
          timer: { value: 600, knownCount: 1, missingCount: 1 },
          elapsed: metric,
          moving: metric,
          unknown: metric,
        },
        sources: { fit: 0, fixture: 0, manual: 2 },
        overlayCount: 0,
      },
      distanceComparison: { actual: 4200, planned: 5000, delta: -800, status: 'available' },
      durationComparison: {
        actual: 600,
        actualKind: 'timer',
        planned: 600,
        delta: null,
        status: 'not_comparable',
        reason: 'planned_duration_definition_missing',
      },
      coverage: 'unknown',
    },
  });
}
const unlinked = activityContextSchema.parse({
  ...envelope,
  activity: { ...activity, userReport: null },
  planContext: { status: 'unlinked' },
});
const thread = (id: string, planVersionId: string, kind: string, targetId: string) => ({
  id,
  planVersionId,
  title: `상담 ${id.slice(0, 4)}`,
  scope: { kind, targetId },
  revision: 1,
  createdAt: '2026-09-16T02:00:00Z',
  updatedAt: '2026-09-16T02:00:00Z',
});
const threads = {
  items: [
    thread('11111111-1111-4111-8111-111111111111', version, 'block', 'block'),
    thread('22222222-2222-4222-8222-222222222222', version, 'session', 'session'),
    thread('33333333-3333-4333-8333-333333333333', version, 'block', 'other-block'),
    thread(
      '44444444-4444-4444-8444-444444444444',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'block',
      'block',
    ),
  ],
  total: 4,
};

function setup(context = linked(), body: unknown = threads) {
  const request = vi.fn((input: TransportRequest) =>
    Promise.resolve({
      status: input.path.startsWith('/bff/v1/coaching-threads?') ? 200 : 404,
      body: z.json().parse(body),
      traceId: null,
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  const view = render(
    wrap(
      <ActivityImpactPanel
        context={context}
        transport={{ request }}
        scope={['users', 'alice', 'sessions', 's', 'activity-browser']}
        coachingHref={(link) =>
          link.kind === 'thread'
            ? `/coach?thread=${link.threadId}`
            : `/coach?planVersion=${link.planVersionId}&scopeKind=${link.scopeKind}&targetId=${link.targetId}`
        }
      />,
    ),
  );
  return { request, view };
}

/** Text that the impact tab must never render (01 §7.2). */
const forbidden = [
  /\d\s*(?:%|％|퍼센트)/,
  /(?:위험|확률|가능성)[^.\n]{0,20}\d/,
  /(?:기여율|기여도|기여 비율|비중|점유율)[^.\n]{0,20}\d/,
  /때문에[^.\n]{0,40}\d/,
];

it('splits the tab into observed, classification and consultation sections, each with its own heading and source', async () => {
  const { request } = setup(linked({ purpose: '유산소 기반', intensityLabel: 'B' }));
  const observed = screen.getByRole('region', { name: '계획 연결과 관측 영향' });
  const classified = screen.getByRole('region', { name: '분류·추정' });
  const consult = screen.getByRole('region', { name: '상담' });
  expect(within(observed).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('관측·계산');
  expect(within(classified).getByRole('heading', { level: 3 })).toHaveTextContent('분류·추정');
  expect(within(consult).getByRole('heading', { level: 3 })).toHaveTextContent('상담');
  expect(within(observed).getByText(/^출처: 이 활동의 기록 값/)).toBeVisible();
  expect(within(observed).getByText(/보고한 RPE: 7 · 사용자 자기 보고/)).toBeVisible();
  expect(within(classified).getByText(/^출처 표시:/)).toBeVisible();
  expect(within(consult).getByText(/^출처: 관측·계산 절의 값에서 고정 규칙/)).toHaveTextContent(
    '계획을 바꾸지 않습니다',
  );
  // The plan's own classification, with its source, version and uncertainty.
  const purpose = within(classified).getByText('유산소 기반').closest('div');
  if (!purpose) throw new Error('purpose item missing');
  expect(purpose).toHaveTextContent('출처: 연결 계획 세션 "계획 달리기"');
  expect(purpose).toHaveTextContent(`버전: 계획 버전 3 · ${version}`);
  expect(purpose).toHaveTextContent('불확실성: 계획을 세울 때 사용자가 붙인 분류입니다.');
  expect(within(classified).getByText('강도 라벨 B')).toBeVisible();
  // No record-based estimate source exists, so there is none.
  expect(within(classified).getByText(/^추정 없음 — 이 활동의 기록에서/)).toBeVisible();
  // Consultation items and related threads for this Block or session of this version only.
  const items = within(consult).getByRole('list', { name: '향후 계획에서 검토할 항목' });
  expect(items).toHaveTextContent('실제 거리가 계획보다 800m 짧았습니다');
  expect(items).toHaveTextContent('보고한 RPE는 7, 계획 목표 RPE는 5로 서로 다릅니다');
  expect(
    within(consult).getByRole('link', { name: '코치에서 연결 Block 검토 열기' }),
  ).toHaveAttribute('href', `/coach?planVersion=${version}&scopeKind=block&targetId=block`);
  const related = await within(consult).findByRole('list', { name: '관련 상담 기록' });
  expect(
    within(related)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href')),
  ).toEqual([
    '/coach?thread=11111111-1111-4111-8111-111111111111',
    '/coach?thread=22222222-2222-4222-8222-222222222222',
  ]);
  // Reads only: nothing but the thread list GET.
  expect(request.mock.calls.map(([input]) => [input.method, input.body])).toEqual([['GET', null]]);
  const text = document.body.textContent ?? '';
  for (const pattern of forbidden) expect(text).not.toMatch(pattern);
});

it('shows 추정 없음 with the reason when no plan is linked, and asks for no related threads', () => {
  const { request } = setup(unlinked);
  const classified = screen.getByRole('region', { name: '분류·추정' });
  expect(
    within(classified).getAllByText(/^추정 없음 — 연결한 계획이 없어 분류 출처가 없습니다/),
  ).toHaveLength(2);
  expect(within(classified).getByText(/^추정 없음 — 이 활동의 기록에서/)).toBeVisible();
  expect(
    screen.getByText('보고한 RPE: 없음. 보고하지 않은 값을 0으로 채우지 않습니다.'),
  ).toBeVisible();
  expect(screen.getByRole('list', { name: '향후 계획에서 검토할 항목' })).toHaveTextContent(
    '계획 연결이 없어 계획 대비 검토 항목을 만들지 않습니다',
  );
  expect(screen.queryByRole('link', { name: '코치에서 연결 Block 검토 열기' })).toBeNull();
  expect(request).not.toHaveBeenCalled();
  const text = document.body.textContent ?? '';
  for (const pattern of forbidden) expect(text).not.toMatch(pattern);
});

it('does not open a coach review from a historical plan version', async () => {
  const value = linked();
  if (value.planContext.status !== 'linked') throw new Error('fixture');
  setup({
    ...value,
    planContext: {
      ...value.planContext,
      currentPlanVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    },
  });
  expect(
    screen.getByText('과거 계획 버전의 Block이라 코치 검토로 바로 연결하지 않습니다.'),
  ).toBeVisible();
  expect(screen.getByRole('list', { name: '향후 계획에서 검토할 항목' })).toHaveTextContent(
    '앞으로의 계획은 현재 버전을 기준으로 검토하세요',
  );
  expect(await screen.findByRole('list', { name: '관련 상담 기록' })).toBeVisible();
});

it('says when only the newest threads were checked and when the thread list failed', async () => {
  const first = setup(linked(), { ...threads, total: 250 });
  expect(await screen.findByText(/최근 상담 4개만 확인했습니다/)).toBeVisible();
  first.view.unmount();
  setup(linked(), { error: { code: 'X' } });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '관련 상담 기록을 확인하지 못했습니다.',
  );
});

it('never shows a classification whose source, version or uncertainty is missing', () => {
  for (const missing of ['source', 'version', 'uncertainty'] as const) {
    const { unmount } = render(
      <dl>
        <ClassificationItem
          item={{
            status: 'classified',
            key: 'purpose',
            label: '목적 분류',
            value: '숨길 값',
            source: '출처',
            version: '버전',
            uncertainty: '불확실성',
            [missing]: ' ',
          }}
        />
      </dl>,
    );
    expect(screen.queryByText('숨길 값')).toBeNull();
    expect(screen.getByText(/^추정 없음 — 출처·버전·불확실성이 없어/)).toBeVisible();
    unmount();
  }
});
