import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { transportReplySchema, type TransportRequest } from '@workout/contracts/core';
import { nutritionPlanVersionV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import {
  nutritionPlanPublicPreviewV4RequestSchema,
  nutritionPlanPublicPreviewV4Schema,
  nutritionPlanPublicApproveV4RequestSchema,
} from '@workout/contracts/nutrition-race-plan-public-v4';
import { createNutritionApi } from '../src/nutrition-api';
import {
  NutritionRaceReconnectEditor,
  retainedNutritionReconnectDraft,
} from '../src/nutrition-race-reconnect-editor';
afterEach(cleanup);
const planId = '81ae88de-3019-4de3-a4b4-9da31df90916',
  versionId = '49440716-5da4-43db-b5c5-8bcda106a8bb',
  eventId = 'ba41f001-1e35-46cf-ad27-d6e4c2c7f581',
  nextId = 'f940c86c-2b04-4aa9-81d5-3eddb45c4f41';
const record = nutritionPlanVersionV3Schema.parse({
  schemaVersion: 3,
  planId,
  versionId,
  version: 1,
  previousVersionId: null,
  approvedAt: '2026-10-06T00:00:00Z',
  approvalId: eventId,
  period: { from: '2026-10-01', toInclusive: '2026-10-31' },
  timezone: 'UTC',
  purpose: 'Retained meal',
  linkedTrainingPlanVersionId: null,
  items: [
    {
      id: '한글-' + 'x'.repeat(201),
      planVersionId: versionId,
      title: 'Suspended meal',
      category: 'before',
      anchor: { kind: 'disconnected', entity: 'race' },
      foods: [
        {
          description: 'Zero',
          foodVersionId: null,
          quantity: 0,
          unit: 'g',
          sourceBasis: 'unknown',
        },
        {
          description: 'Unknown',
          foodVersionId: null,
          quantity: null,
          unit: 'unspecified',
          sourceBasis: 'unknown',
        },
      ],
      targets: [],
      instructions: 'Preserve this action',
      evidenceIds: [],
      source: 'user_confirmed',
    },
    {
      id: 'absolute',
      planVersionId: versionId,
      title: 'Unaffected',
      category: 'meal',
      anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'UTC' },
      foods: [],
      targets: [],
      instructions: 'Preserve',
      evidenceIds: [],
      source: 'user_confirmed',
    },
  ],
  raceTimingPins: [],
  itemRaceTimingBindings: [],
});
const race = {
  id: eventId,
  revision: 2,
  title: 'Owned new race',
  localDate: '2026-10-06',
  localStartTime: '07:00',
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '5k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: null,
  planVersionId: null,
};
const scope = ['users', 'alice', 'sessions', 'one', 'nutrition'] as const;
function safe(draft: NonNullable<ReturnType<typeof retainedNutritionReconnectDraft>>) {
  return {
    ...draft,
    items: draft.items.map(({ source, evidenceIds, ...item }) => {
      void source;
      void evidenceIds;
      return item;
    }),
  };
}
function preview(raw: unknown, blocked = false) {
  const input = nutritionPlanPublicPreviewV4RequestSchema.parse(raw),
    old = retainedNutritionReconnectDraft(record);
  if (!old) throw Error('FIXTURE');
  return nutritionPlanPublicPreviewV4Schema.parse({
    schemaVersion: 4,
    status: blocked ? 'blocked' : 'projected',
    persistence: 'not_stored',
    freshness: 'not_checked',
    approvalAllowed: false,
    expectedPlan: { planId, versionId, version: 1 },
    expectedRaceHeads: input.expectedRaceHeads,
    before: safe(old),
    after: safe(input.draft),
    items: [
      {
        itemId: record.items[0]?.id,
        change: 'affected',
        before: { state: 'suspended', reason: 'race_disconnected' },
        after: blocked
          ? { state: 'unresolved', reason: 'missing_anchor', detail: 'race_end_unknown' }
          : {
              state: 'resolved',
              date: '2026-10-06',
              localTime: '07:00',
              timezone: 'UTC',
              instant: '2026-10-06T07:00:00Z',
            },
      },
      {
        itemId: 'absolute',
        change: 'preserved',
        before: {
          state: 'resolved',
          date: '2026-10-06',
          localTime: null,
          timezone: 'UTC',
          instant: null,
        },
        after: {
          state: 'resolved',
          date: '2026-10-06',
          localTime: null,
          timezone: 'UTC',
          instant: null,
        },
      },
    ],
    notices: [],
    blocks: blocked ? [{ itemId: record.items[0]?.id, code: 'TIMING_UNRESOLVED' }] : [],
  });
}
function setup(
  options: {
    supported?: boolean;
    capabilityFailure?: boolean;
    blocked?: boolean;
    preview?: (request: TransportRequest) => Promise<{ status: number; body: unknown }>;
    approve?: (request: TransportRequest) => Promise<{ status: number; body: unknown }>;
    races?: (request: TransportRequest) => { status: number; body: unknown } | null;
  } = {},
) {
  const requests: TransportRequest[] = [],
    committed = vi.fn();
  const request = vi.fn(async (input: TransportRequest) => {
    requests.push(input);
    if (input.path.endsWith('/capabilities') && options.capabilityFailure) throw Error('NETWORK');
    const raceReply = input.path.startsWith('/bff/v1/races') ? options.races?.(input) : null;
    const reply = raceReply
      ? raceReply
      : input.path.endsWith('/capabilities')
        ? {
            status: 200,
            body: {
              schemaVersion: 1,
              readV4: true,
              previewV4: options.supported ?? true,
              standaloneApprovalV4: true,
            },
          }
        : input.path === '/bff/v1/races?limit=50'
          ? {
              status: 200,
              body: {
                schemaVersion: 1,
                kind: 'race-event',
                sort: 'id-asc',
                collection: { revision: 1, privacyGeneration: '0' },
                items: [race],
                nextCursor: null,
              },
            }
          : input.path.endsWith(`/races/${eventId}`)
            ? { status: 200, body: race }
            : input.path.endsWith('/preview-v4')
              ? options.preview
                ? await options.preview(input)
                : { status: 200, body: preview(input.body, options.blocked) }
              : options.approve
                ? await options.approve(input)
                : { status: 409, body: { error: { code: 'PRIOR_HEAD_STALE' } } };
    return transportReplySchema.parse({ ...reply, traceId: null });
  });
  const api = createNutritionApi({ request }),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderEditor = (latest = record) => (
    <QueryClientProvider client={client}>
      <NutritionRaceReconnectEditor
        api={api}
        scope={scope}
        record={record}
        latestRecord={latest}
        onCommitted={committed}
        newKey={() => 'stable_key_123'}
      />
    </QueryClientProvider>
  );
  const view = render(renderEditor());
  return { requests, request, committed, view, renderEditor };
}
async function select() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '연결 해제 항목 재연결 열기' }));
  await user.click(screen.getByRole('checkbox', { name: '이 항목을 명시적으로 재연결' }));
  await user.selectOptions(await screen.findByLabelText('재연결할 본인 대회'), eventId);
  expect(screen.queryByText(/확인한 대회 Owned/)).toBeNull();
  await user.click(screen.getByRole('button', { name: '선택 대회 현재 버전 확인' }));
  await screen.findByText(/확인한 대회 Owned new race · revision 2/);
  return user;
}
it('requires explicit item/source/preview and a separate checkbox before approval; preview preserves food and other anchors', async () => {
  const b = setup(),
    user = await select();
  expect(b.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  const approve = screen.getByRole('button', { name: '재연결 영양 계획 명시 재승인' });
  expect(approve).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '재연결 영향 미저장 검토' }));
  await screen.findByRole('region', { name: '재연결 미저장 비교' });
  expect(approve).toBeDisabled();
  expect(screen.getByText('Zero · 0 g')).toBeInTheDocument();
  expect(screen.getByText('Unknown · 수량 미상 unspecified')).toBeInTheDocument();
  const sent = b.requests.find((r) => r.path.endsWith('/preview-v4'));
  const body = nutritionPlanPublicPreviewV4RequestSchema.parse(sent?.body);
  expect(body.reconnectItemIds).toEqual([record.items[0]?.id]);
  expect(body.draft.items[1]).toEqual(retainedNutritionReconnectDraft(record)?.items[1]);
  expect(body.draft.items[0]?.foods).toEqual(record.items[0]?.foods);
  expect(sent?.idempotencyKey).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: /미저장 비교와 재연결 항목을 확인했고/ }));
  expect(approve).toBeEnabled();
  fireEvent.change(screen.getByLabelText('전후 분 (이전은 음수)'), { target: { value: '-30' } });
  expect(approve).toBeDisabled();
  expect(screen.queryByRole('region', { name: '재연결 미저장 비교' })).toBeNull();
});

it('blocks unresolved/end preview and never autoapproves from projected support flags', async () => {
  const b = setup({ blocked: true }),
    user = await select();
  await user.selectOptions(screen.getByLabelText('기준 지점'), 'end');
  await user.click(screen.getByRole('button', { name: '재연결 영향 미저장 검토' }));
  await screen.findByText('TIMING_UNRESOLVED');
  expect(screen.getByRole('button', { name: '재연결 영양 계획 명시 재승인' })).toBeDisabled();
  expect(b.requests.some((r) => r.path.endsWith('/approve-v4'))).toBe(false);
});
it('keeps inputs on CAS rejection and requires explicit latest reset', async () => {
  const b = setup(),
    user = await select();
  await user.click(screen.getByRole('button', { name: '재연결 영향 미저장 검토' }));
  await screen.findByRole('region', { name: '재연결 미저장 비교' });
  await user.click(screen.getByRole('checkbox', { name: /미저장 비교와/ }));
  await user.click(screen.getByRole('button', { name: '재연결 영양 계획 명시 재승인' }));
  await screen.findByText(/기준 버전·대회 또는 앱 동의가 변경/);
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue(eventId);
  expect(b.committed).not.toHaveBeenCalled();
  const next = nutritionPlanVersionV3Schema.parse({
    ...record,
    versionId: nextId,
    version: 2,
    previousVersionId: versionId,
    items: record.items.map((item) => ({ ...item, planVersionId: nextId })),
  });
  b.view.rerender(b.renderEditor(next));
  expect(screen.getByText(/서버 기준 버전이 바뀌었습니다/)).toBeInTheDocument();
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue(eventId);
  await user.click(screen.getByRole('button', { name: '최신 승인본으로 입력 초기화' }));
  expect(screen.queryByLabelText('재연결할 본인 대회')).toBeNull();
});
it('locks uncertain approval and retries the immutable same request/key without modifying source or showing premature success', async () => {
  let count = 0;
  const b = setup({
      approve: async (request) => {
        count++;
        if (count === 1) throw Error('NETWORK');
        const intent = nutritionPlanPublicApproveV4RequestSchema.parse(request.body);
        const plan = nutritionPlanVersionV4Schema.parse({
          ...record,
          schemaVersion: 4,
          versionId: nextId,
          version: 2,
          previousVersionId: versionId,
          items: intent.intent.command.draft.items.map((item) => ({
            ...item,
            planVersionId: nextId,
          })),
          raceTimingPins: [
            {
              pinVersion: 1,
              namespace: 'race-event-revision',
              eventId,
              eventRevision: 2,
              sourceDigestVersion: 'race-event-values-canonical-v1',
              sourceDigest: 'a'.repeat(64),
              localDate: '2026-10-06',
              localStartTime: '07:00',
              timezone: 'UTC',
              start: { state: 'known', instant: '2026-10-06T07:00:00Z' },
              end: { state: 'unknown', reason: 'race_end_not_recorded' },
            },
          ],
          itemRaceTimingBindings: [
            {
              itemId: record.items[0]?.id,
              binding: { state: 'captured', eventId, eventRevision: 2 },
            },
          ],
        });
        return { status: 200, body: { schemaVersion: 4, plan, notices: [] } };
      },
    }),
    user = await select();
  await user.click(screen.getByRole('button', { name: '재연결 영향 미저장 검토' }));
  await screen.findByRole('region', { name: '재연결 미저장 비교' });
  await user.click(screen.getByRole('checkbox', { name: /미저장 비교와/ }));
  await user.click(screen.getByRole('button', { name: '재연결 영양 계획 명시 재승인' }));
  await screen.findByText(/승인 결과를 확인할 수 없습니다/);
  expect(screen.getByLabelText('재연결할 본인 대회')).toBeDisabled();
  expect(b.committed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '같은 요청과 키로 승인 결과 확인' }));
  await screen.findByText(/재연결과 재승인이 서버에 반영되었습니다/);
  expect(b.committed).toHaveBeenCalledTimes(1);
  const writes = b.requests.filter((r) => r.path.endsWith('/approve-v4'));
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body).toEqual(writes[1]?.body);
  expect(writes.map((r) => r.idempotencyKey)).toEqual(['stable_key_123', 'stable_key_123']);
  const body = nutritionPlanPublicApproveV4RequestSchema.parse(writes[0]?.body);
  expect(body.intent.command.draft.items[0]?.foods).toEqual(record.items[0]?.foods);
  expect(body).not.toHaveProperty('planId');
});
it('does not expose processing controls for absent preview capability and makes no race reads', async () => {
  const b = setup({ supported: false });
  await screen.findByText(/모두 지원하지 않습니다/);
  expect(screen.getByRole('button', { name: '연결 해제 항목 재연결 열기' })).toBeDisabled();
  expect(b.requests.every((r) => r.path.endsWith('/capabilities'))).toBe(true);
});
it('preserves the readonly record and denies editing when capability discovery fails', async () => {
  const b = setup({ capabilityFailure: true });
  await screen.findByText(/재연결 지원을 확인하지 못했습니다/);
  expect(screen.getByRole('button', { name: '연결 해제 항목 재연결 열기' })).toBeDisabled();
  expect(screen.queryByLabelText('재연결할 본인 대회')).toBeNull();
  expect(b.requests.every((request) => request.path.endsWith('/capabilities'))).toBe(true);
  expect(b.committed).not.toHaveBeenCalled();
});
it('aborts pending preview on private editor unmount rather than updating a new session', async () => {
  const b = setup({
    preview: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(Error('ABORT')), { once: true });
      }),
  });
  const user = await select();
  await user.click(screen.getByRole('button', { name: '재연결 영향 미저장 검토' }));
  const pending = b.requests.find((request) => request.path.endsWith('/preview-v4'));
  expect(pending?.signal?.aborted).toBe(false);
  b.view.unmount();
  await waitFor(() => expect(pending?.signal?.aborted).toBe(true));
  expect(b.committed).not.toHaveBeenCalled();
});

const pagedRaces = Array.from({ length: 120 }, (_, index) => ({
  ...race,
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  title: `Owned race ${String(index + 1).padStart(3, '0')}`,
}));
function pagedServer(options: { failNext?: number; stale?: number; revision?: () => number } = {}) {
  let failures = options.failNext ?? 0,
    stale = options.stale ?? 0;
  return (input: TransportRequest) => {
    const url = new URL(input.path, 'https://synthetic.invalid');
    const byId = pagedRaces.find((item) => url.pathname === `/bff/v1/races/${item.id}`);
    if (byId) return { status: 200, body: byId };
    if (url.pathname !== '/bff/v1/races') return null;
    expect(url.searchParams.get('limit')).toBe('50');
    const raw = url.searchParams.get('cursor');
    const cursor = raw === null ? null : (JSON.parse(raw) as { afterId: string });
    if (cursor !== null && failures > 0) {
      failures--;
      return { status: 503, body: { error: { code: 'UNAVAILABLE' } } };
    }
    if (cursor !== null && stale > 0) {
      stale--;
      return { status: 409, body: { error: { code: 'RACE_CURSOR_STALE' } } };
    }
    const collection = { revision: options.revision?.() ?? 1, privacyGeneration: '0' };
    const rest = pagedRaces.filter((item) => cursor === null || item.id > cursor.afterId);
    const items = rest.slice(0, 50),
      last = items.at(-1);
    return {
      status: 200,
      body: {
        schemaVersion: 1,
        kind: 'race-event',
        sort: 'id-asc',
        collection,
        items,
        nextCursor:
          rest.length > items.length && last
            ? { kind: 'race-event', collection, afterId: last.id }
            : null,
      },
    };
  };
}
const listCalls = (requests: TransportRequest[]) =>
  requests.filter((r) => new URL(r.path, 'https://synthetic.invalid').pathname === '/bff/v1/races');
async function openPaged() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '연결 해제 항목 재연결 열기' }));
  await user.click(screen.getByRole('checkbox', { name: '이 항목을 명시적으로 재연결' }));
  await screen.findByText('불러온 본인 대회 50개 · 더 있습니다. 전체 목록이 아닙니다.');
  return user;
}
const optionCount = () =>
  screen.getByLabelText<HTMLSelectElement>('재연결할 본인 대회').options.length - 1;
it('loads later own-race pages only on explicit keyboard request and reconnects a race beyond the first 50 through preview and explicit approval', async () => {
  const target = pagedRaces[69];
  if (!target) throw Error('FIXTURE');
  const b = setup({
    races: pagedServer(),
    approve: async (request) => {
      const intent = nutritionPlanPublicApproveV4RequestSchema.parse(request.body);
      const plan = nutritionPlanVersionV4Schema.parse({
        ...record,
        schemaVersion: 4,
        versionId: nextId,
        version: 2,
        previousVersionId: versionId,
        items: intent.intent.command.draft.items.map((item) => ({
          ...item,
          planVersionId: nextId,
        })),
        raceTimingPins: [
          {
            pinVersion: 1,
            namespace: 'race-event-revision',
            eventId: target.id,
            eventRevision: 2,
            sourceDigestVersion: 'race-event-values-canonical-v1',
            sourceDigest: 'a'.repeat(64),
            localDate: '2026-10-06',
            localStartTime: '07:00',
            timezone: 'UTC',
            start: { state: 'known', instant: '2026-10-06T07:00:00Z' },
            end: { state: 'unknown', reason: 'race_end_not_recorded' },
          },
        ],
        itemRaceTimingBindings: [
          {
            itemId: record.items[0]?.id,
            binding: { state: 'captured', eventId: target.id, eventRevision: 2 },
          },
        ],
      });
      return { status: 200, body: { schemaVersion: 4, plan, notices: [] } };
    },
  });
  const user = await openPaged();
  expect(optionCount()).toBe(50);
  expect(screen.queryByRole('option', { name: /Owned race 070/ })).toBeNull();
  expect(listCalls(b.requests)).toHaveLength(1);
  // Choosing on page 1 is kept while paging.
  await user.selectOptions(screen.getByLabelText('재연결할 본인 대회'), pagedRaces[2]?.id ?? '');
  const more = screen.getByRole('button', { name: '대회 더 보기 (최대 50개)' });
  more.focus();
  await user.keyboard('{Enter}');
  await screen.findByText('불러온 본인 대회 100개 · 더 있습니다. 전체 목록이 아닙니다.');
  expect(optionCount()).toBe(100);
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue(pagedRaces[2]?.id);
  const second = listCalls(b.requests)[1];
  const cursor = new URL(second?.path ?? '', 'https://synthetic.invalid').searchParams.get(
    'cursor',
  );
  expect(JSON.parse(cursor ?? 'null')).toEqual({
    kind: 'race-event',
    collection: { revision: 1, privacyGeneration: '0' },
    afterId: pagedRaces[49]?.id,
  });
  expect(b.requests.some((r) => r.method === 'POST')).toBe(false);
  await user.selectOptions(screen.getByLabelText('재연결할 본인 대회'), target.id);
  await user.click(screen.getByRole('button', { name: '선택 대회 현재 버전 확인' }));
  await screen.findByText(/확인한 대회 Owned race 070 · revision 2/);
  await user.click(screen.getByRole('button', { name: '재연결 영향 미저장 검토' }));
  await screen.findByRole('region', { name: '재연결 미저장 비교' });
  const sent = nutritionPlanPublicPreviewV4RequestSchema.parse(
    b.requests.find((r) => r.path.endsWith('/preview-v4'))?.body,
  );
  expect(sent.draft.items[0]?.anchor).toMatchObject({ entity: 'race', entityId: target.id });
  expect(sent.expectedRaceHeads).toEqual([
    { namespace: 'race-event', eventId: target.id, revision: 2 },
  ]);
  const approve = screen.getByRole('button', { name: '재연결 영양 계획 명시 재승인' });
  expect(approve).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /미저장 비교와/ }));
  await user.click(approve);
  await screen.findByText(/재연결과 재승인이 서버에 반영되었습니다/);
  expect(b.committed).toHaveBeenCalledTimes(1);
  expect(b.requests.filter((r) => r.path.endsWith('/approve-v4'))).toHaveLength(1);
});
it('shows an honest end state, never auto-selects, and dedupes candidates by race id', async () => {
  const b = setup({ races: pagedServer() });
  const user = await openPaged();
  await user.click(screen.getByRole('button', { name: '대회 더 보기 (최대 50개)' }));
  await screen.findByText(/불러온 본인 대회 100개/);
  await user.click(screen.getByRole('button', { name: '대회 더 보기 (최대 50개)' }));
  await screen.findByText('본인 대회 120개를 모두 불러왔습니다.');
  expect(screen.queryByRole('button', { name: /대회 더 보기/ })).toBeNull();
  expect(optionCount()).toBe(120);
  const ids = [...screen.getByLabelText<HTMLSelectElement>('재연결할 본인 대회').options].map(
    (o) => o.value,
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue('');
  expect(screen.getByRole('button', { name: '선택 대회 현재 버전 확인' })).toBeDisabled();
  expect(listCalls(b.requests)).toHaveLength(3);
  expect(b.requests.some((r) => r.method === 'POST')).toBe(false);
});
it('keeps loaded candidates and selection when a later page fails, and retries the same cursor', async () => {
  const b = setup({ races: pagedServer({ failNext: 1 }) });
  const user = await openPaged();
  await user.selectOptions(screen.getByLabelText('재연결할 본인 대회'), pagedRaces[4]?.id ?? '');
  await user.click(screen.getByRole('button', { name: '대회 더 보기 (최대 50개)' }));
  await screen.findByText(/다음 대회를 불러오지 못했습니다/);
  expect(optionCount()).toBe(50);
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue(pagedRaces[4]?.id);
  await user.click(screen.getByRole('button', { name: '다음 대회 다시 불러오기' }));
  await screen.findByText(/불러온 본인 대회 100개/);
  expect(screen.queryByText(/다음 대회를 불러오지 못했습니다/)).toBeNull();
  const calls = listCalls(b.requests);
  expect(calls).toHaveLength(3);
  expect(calls[1]?.path).toBe(calls[2]?.path);
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue(pagedRaces[4]?.id);
});
it('requires an explicit restart when the race collection changed between pages, keeping the selection', async () => {
  let revision = 1;
  const b = setup({ races: pagedServer({ stale: 1, revision: () => revision }) });
  const user = await openPaged();
  await user.click(screen.getByRole('button', { name: '대회 더 보기 (최대 50개)' }));
  await screen.findByText(/대회 목록이 바뀌어 다음 대회를 이어서 불러올 수 없습니다/);
  // A selection made on the already loaded page survives the restart.
  await user.selectOptions(screen.getByLabelText('재연결할 본인 대회'), pagedRaces[1]?.id ?? '');
  revision = 2;
  await user.click(screen.getByRole('button', { name: '대회 목록 처음부터 다시 불러오기' }));
  await waitFor(() => expect(screen.queryByText(/대회 목록이 바뀌어/)).toBeNull());
  expect(screen.getByLabelText('재연결할 본인 대회')).toHaveValue(pagedRaces[1]?.id);
  const first = listCalls(b.requests).at(-1);
  expect(new URL(first?.path ?? '', 'https://synthetic.invalid').searchParams.has('cursor')).toBe(
    false,
  );
});
it('reports a failed first race page with an explicit retry instead of an empty list', async () => {
  let fail = true;
  const server = pagedServer();
  setup({
    races: (input) =>
      fail && input.path.startsWith('/bff/v1/races?')
        ? { status: 503, body: { error: { code: 'UNAVAILABLE' } } }
        : server(input),
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '연결 해제 항목 재연결 열기' }));
  await screen.findByText(/대회 목록을 불러오지 못했습니다/);
  expect(screen.queryByText(/모두 불러왔습니다/)).toBeNull();
  fail = false;
  await user.click(screen.getByRole('button', { name: '대회 목록 다시 불러오기' }));
  await screen.findByText(/불러온 본인 대회 50개/);
});
