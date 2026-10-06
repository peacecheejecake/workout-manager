import { expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { createCompetitionRelationApi } from '../src/competition-relation-api';
const id = '10000000-0000-4000-8000-000000000001';
const revisionId = '10000000-0000-4000-8000-000000000002';
const at = '2026-10-01T00:00:00Z';
const course = {
  status: 'available',
  courseId: id,
  name: '강변 코스',
  visibility: 'private',
  headRevision: 3,
  revisionId,
  createdAt: at,
  updatedAt: at,
};
const values = {
  title: '아침 달리기',
  kind: 'running',
  startedAt: at,
  durationSeconds: null,
  durationKind: 'unknown',
  timezone: 'Asia/Seoul',
  distanceMeters: null,
};
const activity = {
  id,
  revision: 1,
  source: { kind: 'manual', sourceId: 'synthetic', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};
function setup(body: unknown, status = 200) {
  const request = vi.fn<AuthenticatedTransport['request']>(async () =>
    transportReplySchema.parse({ status, body, traceId: null }),
  );
  return {
    request,
    api: createCompetitionRelationApi({ request }),
    signal: new AbortController().signal,
  };
}
it('reads the available current immutable course tuple without fetching geometry', async () => {
  const unavailable = {
    status: 'unavailable',
    courseId: revisionId,
    name: '삭제된 원본 코스',
    visibility: 'private',
    reason: 'source_activity_deleted',
    reclaimedAt: at,
    createdAt: at,
    updatedAt: at,
  };
  const { api, request, signal } = setup({ courses: [course, unavailable], total: 2 });
  expect(await api.courses(signal)).toEqual({
    total: 2,
    choices: [
      { ref: { courseId: id, courseRevision: 3, revisionId }, label: '강변 코스 · 버전 3' },
    ],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith({
    path: '/bff/v1/courses',
    method: 'GET',
    body: null,
    idempotencyKey: null,
    signal,
  });
});
it('uses bounded plan history metadata and removes unsafe/raw ID display text', async () => {
  const { api, signal } = setup({
    head: null,
    history: [{ id, version: 2, createdAt: at, title: `\u0001 ${id} 가을 계획` }],
  });
  expect(await api.plans(signal)).toEqual({
    total: 1,
    choices: [{ id, label: '가을 계획 · 계획 v2' }],
  });
});
it('reads canonical Activity effective labels with an explicit first-page query', async () => {
  const { api, request, signal } = setup({
    items: Array.from({ length: 100 }, (_, index) => ({
      ...activity,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
    total: 125,
  });
  const result = await api.activities(signal);
  expect(result.total).toBe(125);
  expect(result.choices).toHaveLength(100);
  expect(result.choices[0]).toEqual({ id, label: '아침 달리기 · 2026. 10. 01.' });
  const path = request.mock.calls[0]?.[0].path;
  expect(path).toBe('/bff/v1/activities?limit=100&offset=0&sort=started_desc');
});
it('keeps unknown title/date semantic and does not invent zero metrics', async () => {
  const { api, signal } = setup({
    items: [
      { ...activity, effective: { ...values, title: null, startedAt: null, timezone: null } },
    ],
    total: 1,
  });
  expect((await api.activities(signal)).choices[0]?.label).toBe('달리기 · 날짜 미상');
});
it.each([
  ['plans', { head: null, history: [], secret: true }],
  ['courses', { courses: [course, course], total: 2 }],
  ['courses', { courses: [course], total: 0 }],
  [
    'activities',
    {
      items: [
        {
          id,
          title: 'legacy shell fixture',
          startedAt: at,
          durationSeconds: null,
          source: 'fixture',
        },
      ],
    },
  ],
  ['activities', { items: [activity, activity], total: 2 }],
  ['activities', { items: [activity], total: 0 }],
] as const)('rejects malformed/legacy/duplicate %s DTO', async (kind, body) => {
  const { api, signal } = setup(body);
  await expect(api[kind](signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('sanitizes HTTP failure without returning its payload', async () => {
  const { api, signal } = setup({ error: 'private health body' }, 503);
  await expect(api.plans(signal)).rejects.toMatchObject({
    code: 'UNAVAILABLE',
    message: 'UNAVAILABLE',
  });
});
it('ignores a late response after cancellation even when transport ignores abort', async () => {
  const controller = new AbortController();
  const { api } = setup({ head: null, history: [] });
  controller.abort();
  await expect(api.plans(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
