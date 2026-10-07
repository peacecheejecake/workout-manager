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
  } = {},
) {
  const requests: TransportRequest[] = [],
    committed = vi.fn();
  const request = vi.fn(async (input: TransportRequest) => {
    requests.push(input);
    if (input.path.endsWith('/capabilities') && options.capabilityFailure) throw Error('NETWORK');
    const reply = input.path.endsWith('/capabilities')
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
