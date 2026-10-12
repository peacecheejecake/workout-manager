import { expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { createGalleryCourseChoicesApi } from '../src/gallery-course-choices-api';
const id = '10000000-0000-4000-8000-000000000001';
const revisionId = '10000000-0000-4000-8000-000000000002';
const head = {
  status: 'available',
  courseId: id,
  name: '내 코스',
  visibility: 'private',
  headRevision: 4,
  revisionId,
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};
function fixture(body: unknown = { courses: [head], total: 1 }, status = 200) {
  const reply = transportReplySchema.parse({ status, body, traceId: null });
  const request = vi.fn<AuthenticatedTransport['request']>(async () => reply);
  return { api: createGalleryCourseChoicesApi({ request }), request, reply };
}
it('reads current heads with no write or key and projects only the exact returned tuple', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  expect(await f.api.list(signal)).toEqual({
    choices: [{ label: '내 코스', link: { courseId: id, courseRevision: 4, revisionId } }],
    unavailableCount: 0,
  });
  expect(f.request).toHaveBeenCalledExactlyOnceWith({
    method: 'GET',
    path: '/bff/v1/courses',
    body: null,
    idempotencyKey: null,
    signal,
  });
});
it('distinguishes empty from unavailable heads without inventing a revision or revealing a reason', async () => {
  const { headRevision: ignored, revisionId: ignoredId, ...common } = head;
  void ignored;
  void ignoredId;
  const result = await fixture({
    courses: [
      {
        ...common,
        status: 'unavailable',
        reason: 'source_activity_deleted',
        reclaimedAt: head.updatedAt,
      },
    ],
    total: 1,
  }).api.list();
  expect(result).toEqual({ choices: [], unavailableCount: 1 });
  expect(await fixture({ courses: [], total: 0 }).api.list()).toEqual({
    choices: [],
    unavailableCount: 0,
  });
});
it.each([
  { courses: [head, head], total: 2 },
  { courses: [head], total: 0 },
  { courses: [{ ...head, revisionId: null }], total: 1 },
  { courses: [{ ...head, headRevision: Number.MAX_SAFE_INTEGER + 1 }], total: 1 },
  { courses: [{ ...head, foreignOwner: id }], total: 1 },
  { courses: Array(201).fill(head), total: 201 },
])('rejects malformed, duplicate or inconsistent head replies', async (body) => {
  await expect(fixture(body).api.list()).rejects.toMatchObject({
    code: 'INVALID_REPLY',
    status: null,
  });
});
it.each([400, 404, 409, 502])(
  'sanitizes HTTP %s without retries or raw body text',
  async (status) => {
    const f = fixture({ error: { code: 'private-value', message: 'sensitive' } }, status);
    await expect(f.api.list()).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      status,
      message: 'REQUEST_FAILED',
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  },
);
it('rejects an unexpected successful status', async () => {
  await expect(fixture(undefined, 201).api.list()).rejects.toMatchObject({ code: 'INVALID_REPLY' });
});
it('rejects accessors before reading the envelope or nested head', async () => {
  const f = fixture();
  const getter = vi.fn(() => ({ courses: [head], total: 1 }));
  Object.defineProperty(f.reply, 'body', { get: getter, enumerable: true });
  await expect(f.api.list()).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  expect(getter).not.toHaveBeenCalled();
  const nested = fixture();
  const body = nested.reply.body;
  expect(typeof body).toBe('object');
  const accessor = vi.fn(() => 4);
  const unsafe = { ...head };
  Object.defineProperty(unsafe, 'headRevision', { get: accessor, enumerable: true });
  nested.reply.body = { courses: [unsafe], total: 1 };
  await expect(nested.api.list()).rejects.toMatchObject({ code: 'INVALID_REPLY' });
  expect(accessor).not.toHaveBeenCalled();
});
it('preserves cancellation before and after an uncooperative transport reply', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  await expect(f.api.list(controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  expect(f.request).not.toHaveBeenCalled();
  const late = new AbortController();
  const g = fixture();
  g.request.mockImplementation(async () => {
    late.abort();
    return g.reply;
  });
  await expect(g.api.list(late.signal)).rejects.toMatchObject({ code: 'ABORTED' });
});
it('sanitizes transport rejection without retry', async () => {
  const f = fixture();
  f.request.mockRejectedValue(new Error('private'));
  await expect(f.api.list()).rejects.toMatchObject({
    code: 'TRANSPORT_FAILED',
    status: null,
    message: 'TRANSPORT_FAILED',
  });
  expect(f.request).toHaveBeenCalledTimes(1);
});
