import '@testing-library/jest-dom/vitest';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityContextSchema } from '@workout/contracts/activity-context';
import type { TransportRequest } from '@workout/contracts/core';
import { ActivityImpactPanel } from '../src/activity-impact-panel';
import { ClassificationItem } from '../src/impact-classification';
import { consultationItems } from '../src/impact-split';
import { forbiddenImpactMatches, forbiddenImpactText } from './impact-forbidden';

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
function linked(session: Record<string, unknown> = {}, plan: Record<string, unknown> = {}) {
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
      ...plan,
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

/**
 * The screen's text as textContent (no separators) and as every text node joined by a space,
 * the way the E2E reads it, so both reads are checked against the same list.
 */
function forbiddenOnScreen() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    parts.push(node.textContent ?? '');
  return [
    ...forbiddenImpactMatches(document.body.textContent ?? ''),
    ...forbiddenImpactMatches(parts.join(' ')),
  ];
}

function setup(
  context = linked(),
  body: unknown = threads,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  let current = body;
  const request = vi.fn((input: TransportRequest) =>
    Promise.resolve({
      status: input.path.startsWith('/bff/v1/coaching-threads?') ? 200 : 404,
      body: z.json().parse(current),
      traceId: null,
    }),
  );
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
  return {
    request,
    view,
    respondWith: (next: unknown) => {
      current = next;
    },
  };
}

it('splits the tab into observed, classification and consultation sections, each with its own heading and source', async () => {
  const { request } = setup(linked({ purpose: '유산소 기반', intensityLabel: 'B' }));
  const observed = screen.getByRole('region', { name: '관측·계산' });
  const classified = screen.getByRole('region', { name: '분류·추정' });
  const consult = screen.getByRole('region', { name: '상담' });
  // The observed section is named by its own heading, not by a separate label.
  const observedHeading = within(observed).getAllByRole('heading', { level: 3 })[0];
  expect(observedHeading).toHaveTextContent('관측·계산');
  expect(observed).toHaveAttribute('aria-labelledby', observedHeading?.id);
  expect(observed).not.toHaveAttribute('aria-label');
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
  expect(forbiddenOnScreen()).toEqual([]);
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
  expect(forbiddenOnScreen()).toEqual([]);
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

/** Forms of share, risk and causal number the M2-01k-m list missed; each must now be caught. */
const widened = [
  'Block 거리의 0.84 비중',
  '부상 위험이 １２％ 늘었습니다',
  '위험도 １２',
  '３ 확률로 부상',
  '12 가능성',
  '이 활동의 기여 0.3',
  '12 기여',
  'risk 12',
  '12 percent',
  '12프로 증가',
  '리스크 3',
  'Block 거리 중 3/5',
  'Block 거리의 5분의 3',
  '거리의 ⅗',
  '이번 활동 때문에\n12 늘었습니다',
  '12 증가는 이번 활동 때문입니다',
  '피로 12의 원인은 이번 활동입니다',
  '이번 활동으로 인해 12 늘었습니다',
  // M2-01am review round 1
  '이 활동이 Block 합계에서 차지하는 비율은 0.84입니다.',
  '이 활동의 비율 0.84',
  '몫은 0.84',
  'Block 거리의 84를 차지합니다',
  '3:2 비율',
  'Block share 0.84',
  'likelihood 0.3',
  'chance 12 in 100',
  'odds 1 in 5',
  '이번 활동으로 인한 피로 12 증가',
  '이번 활동의 영향으로 거리가 12 늘었습니다',
  'as a result, fatigue rose 12',
  'caused by this run: 12',
  // M2-01am review round 2
  '계획 이행률 0.84',
  '달성률 84',
  '완료율 0.9',
  '12 percentage points',
  '12pp 늘었습니다',
];
/** Allow-listed values: calendar, identifiers, heart-rate zones and the observed partial sum. */
const allowed = [
  '관측 시각: 2019-03-02T08:00:00.000Z · 정의 activity-context-v1',
  '출처: 관측·계산 절의 값에서 고정 규칙(activity-impact-consultation-v1)으로 고른 검토 항목',
  '보고 시각 2026-09-16T01:00:00Z',
  '연결 Block: 연결 Block · 2026-09-01 ~ 2026-09-20 (종료일 제외) · Asia/Seoul',
  '버전: 계획 버전 3 · bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '심박 구간 2 비중은 계산하지 않습니다',
  'Z2 시간의 비중을 계산하지 않습니다',
  '2019/03/02 기록입니다. 위험을 계산하지 않습니다.',
  '3월 2일 기록입니다. 기여율을 계산하지 않습니다.',
  '보고한 RPE: 7 · RPE 7/10 척도',
  'duration 1500 · 12 percentile',
  '확인한 활동 3개',
  '평균 페이스 100:00/km · 8:05:30 경과',
  '이 활동이 Block 합계에서 차지하는 비율은 계산하지 않습니다. 수집 완전성이 미확인이라 분모가 불완전하므로, 관측·계산 절의 부분 합계만 보여 줍니다.',
  '이 활동의 합계 기여: 거리 4200m · 시간 1500초 · 타이머 시간 (timer)',
  // The same line as separate text nodes joined by spaces (the E2E's element-wise read).
  '이 활동의 합계 기여: 거리   4200m  ·  시간   1500초 · 타이머 시간 (timer)',
  '이 활동은 연결 Block의 날짜 범위 밖에 있어 해당 Block 부분 합계에 기여하지 않습니다.',
  '계획 이행률·기여율·훈련 부하·부상 위험·회복 효능을 계산하지 않습니다.',
  '12개 프로그램',
];
const previous = [
  /\d\s*(?:%|％|퍼센트)/,
  /(?:위험|확률|가능성)[^.\n]{0,20}\d/,
  /(?:기여율|기여도|기여 비율|비중|점유율)[^.\n]{0,20}\d/,
  /때문에[^.\n]{0,40}\d/,
];

it('catches shares, risks and causal numbers in every written form, and allows dates, ids and heart-rate zones', () => {
  for (const text of widened) {
    expect(forbiddenImpactMatches(text), text).not.toEqual([]);
    // Each of these slipped past the M2-01k-m list.
    expect(
      previous.some((pattern) => pattern.test(text)),
      text,
    ).toBe(false);
  }
  for (const text of allowed) expect(forbiddenImpactMatches(text), text).toEqual([]);
  // The allow-list masks identifiers only; a share next to them is still caught, and a date,
  // time or id in the same sentence as a share word is not masked at all.
  for (const text of [
    '심박 구간 2 비중 84',
    '2019-03-02 위험 12',
    '위험 12:30',
    '위험 2019-03-02',
    '위험 bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '이번 활동 때문에 회복 시간이 1:30 늘었습니다',
    '12:30 증가는 이번 활동 때문입니다',
  ])
    expect(forbiddenImpactMatches(text), text).not.toEqual([]);
  // Known conservative false positives (documented): a number in a disclaimer sentence.
  for (const text of [
    '버전 3 · 확률을 계산하지 않습니다',
    '2019/03/02 기록의 위험을 계산하지 않습니다',
    '관측 활동 2개\n부분 합계는 이 활동 때문이 아닙니다',
  ])
    expect(forbiddenImpactMatches(text), text).not.toEqual([]);
  expect(forbiddenImpactText.every((pattern) => pattern.unicode)).toBe(true);
});

it('says why a stored plan link cannot be read, separately for a missing plan and an out-of-range calendar', async () => {
  const base = linked();
  const unavailable = (reason: 'linked_plan_unavailable' | 'unsupported_calendar') =>
    activityContextSchema.parse({ ...base, planContext: { status: 'unavailable', reason } });
  const first = setup(unavailable('linked_plan_unavailable'));
  const consult = screen.getByRole('region', { name: '상담' });
  expect(
    within(consult).getByText('저장된 계획 연결을 확인할 수 없어 관련 상담을 찾지 않습니다.'),
  ).toBeVisible();
  expect(within(consult).queryByText(/연결한 계획이 없어/)).toBeNull();
  expect(
    within(screen.getByRole('region', { name: '분류·추정' })).getAllByText(
      /^추정 없음 — 저장된 계획 연결을 확인할 수 없어 분류 출처가 없습니다/,
    ),
  ).toHaveLength(2);
  expect(first.request).not.toHaveBeenCalled();
  first.view.unmount();

  const second = setup(unavailable('unsupported_calendar'));
  const classified = screen.getByRole('region', { name: '분류·추정' });
  expect(
    within(classified).getAllByText(
      /^추정 없음 — 기록 또는 연결 계획에 지원 범위를 벗어난 날짜가 있어 연결 계획의 분류를 읽지 않습니다/,
    ),
  ).toHaveLength(2);
  expect(within(classified).queryByText(/저장된 계획 연결을 확인할 수 없어/)).toBeNull();
  const calendarConsult = screen.getByRole('region', { name: '상담' });
  expect(
    within(calendarConsult).getByRole('list', { name: '향후 계획에서 검토할 항목' }),
  ).toHaveTextContent('지원 범위를 벗어난 날짜가 있어 계획과 비교하지 않았고');
  expect(
    within(calendarConsult).getByText(
      '기록 또는 연결 계획에 지원 범위를 벗어난 날짜가 있어 관련 상담을 찾지 않습니다.',
    ),
  ).toBeVisible();
  expect(second.request).not.toHaveBeenCalled();
  expect(forbiddenOnScreen()).toEqual([]);
});

it('words a distance outside the planned range as exceeding it or falling short of it', () => {
  // The activity ran 4200m.
  const ranged = (minMeters: number, maxMeters: number, rangePosition: 'below' | 'above') =>
    linked(
      { distanceMeters: null, distanceRange: { minMeters, maxMeters } },
      {
        distanceComparison: {
          actual: 4200,
          planned: null,
          plannedRange: { minMeters, maxMeters },
          rangePosition,
          delta: null,
          status: 'range_available',
        },
      },
    );
  expect(consultationItems(ranged(5000, 6000, 'below'))[0]).toBe(
    '실제 거리가 계획 거리 범위에 못 미쳤습니다. 다음 세션의 거리 목표를 검토할 때 참고하세요.',
  );
  expect(consultationItems(ranged(3000, 4000, 'above'))[0]).toBe(
    '실제 거리가 계획 거리 범위를 초과했습니다. 다음 세션의 거리 목표를 검토할 때 참고하세요.',
  );
});

it('reads the related threads again when the page is shown again, even under a long default freshness', async () => {
  // The workspace clients elsewhere keep reads fresh for 30 seconds; a thread made on the
  // coach screen in the meantime must still show up when the user comes back.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const onlyFirst = { items: [threads.items[0]], total: 1 };
  const { request, respondWith } = setup(linked(), onlyFirst, client);
  const related = await screen.findByRole('list', { name: '관련 상담 기록' });
  expect(within(related).getAllByRole('link')).toHaveLength(1);
  respondWith(threads);
  act(() => {
    focusManager.setFocused(false);
  });
  act(() => {
    focusManager.setFocused(true);
  });
  await vi.waitFor(() => expect(within(related).getAllByRole('link')).toHaveLength(2));
  expect(request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'GET']);
  act(() => {
    focusManager.setFocused(undefined);
  });
});
