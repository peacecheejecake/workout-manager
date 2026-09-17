import { describe, it, expect } from 'vitest';
import {
  coachingThreadCreateSchema,
  coachingMessageAppendSchema,
  coachingThreadSchema,
  coachingUserMessageSchema,
  coachingThreadListQuerySchema,
  coachingMessagesQuerySchema,
  coachingMessagesSchema,
  coachingMessageResultSchema,
} from '../src/coaching-threads.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const create = {
  planVersionId: id,
  title: '검토',
  scope: { kind: 'session', targetId: '세션 / 1' },
  message: '  질문\n내용  ',
  idempotencyKey: 'request',
};
const thread = {
  id,
  planVersionId: id,
  title: '검토',
  scope: create.scope,
  revision: 1,
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
};
const message = {
  id,
  threadId: id,
  revision: 1,
  role: 'user',
  content: create.message,
  createdAt: thread.createdAt,
};
describe('coaching thread wire contracts', () => {
  it('canonicalizes UUID input for stable command receipts', () => {
    expect(
      coachingThreadCreateSchema.parse({ ...create, planVersionId: id.toUpperCase() })
        .planVersionId,
    ).toBe(id);
  });
  it('preserves user text and supports immutable supported scopes', () => {
    expect(coachingThreadCreateSchema.parse(create)).toEqual(create);
    for (const kind of ['session', 'block', 'phase'])
      expect(
        coachingThreadCreateSchema.safeParse({ ...create, scope: { kind, targetId: 'x' } }).success,
      ).toBe(true);
  });
  it.each([
    { message: ' \n ' },
    { message: 'x'.repeat(8001) },
    { message: 'x\0y' },
    { title: ' trim' },
    { title: 'x\0' },
    { title: 'x'.repeat(201) },
    { planVersionId: 'bad' },
    { scope: { kind: 'wave', targetId: 'x' } },
    { scope: { kind: 'session', targetId: '\0' } },
    { scope: { kind: 'session', targetId: 'x'.repeat(201) } },
    { role: 'assistant' },
    { athleteId: 'foreign' },
    { idempotencyKey: '' },
  ])('rejects malformed create %j', (patch) =>
    expect(coachingThreadCreateSchema.safeParse({ ...create, ...patch }).success).toBe(false),
  );
  it('rejects missing and invalid revision fields and any assistant message', () => {
    expect(coachingThreadCreateSchema.safeParse({}).success).toBe(false);
    for (const revision of [0, -1, 1.5, 2147483647]) {
      expect(coachingThreadSchema.safeParse({ ...thread, revision }).success).toBe(false);
      expect(
        coachingMessageAppendSchema.safeParse({
          expectedRevision: revision,
          message: 'x',
          idempotencyKey: 'x',
        }).success,
      ).toBe(false);
    }
    expect(coachingUserMessageSchema.safeParse({ ...message, role: 'assistant' }).success).toBe(
      false,
    );
  });
  it('bounds pages and rejects unknown query fields', () => {
    expect(coachingThreadListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(coachingMessagesQuerySchema.parse({})).toEqual({ limit: 50, afterRevision: 0 });
    expect(coachingThreadListQuerySchema.parse({ limit: '100', offset: '10000' })).toEqual({
      limit: 100,
      offset: 10000,
    });
    for (const query of [{ limit: 101 }, { limit: 0 }, { offset: 10001 }, { athleteId: 'x' }])
      expect(coachingThreadListQuerySchema.safeParse(query).success).toBe(false);
    expect(coachingMessagesQuerySchema.safeParse({ afterRevision: 2147483647 }).success).toBe(
      false,
    );
  });
  it('rejects mismatched or unordered response messages', () => {
    expect(coachingMessageResultSchema.safeParse({ thread, message }).success).toBe(true);
    expect(
      coachingMessageResultSchema.safeParse({ thread, message: { ...message, revision: 2 } })
        .success,
    ).toBe(false);
    expect(
      coachingMessagesSchema.safeParse({ thread, messages: [message, message], hasMore: false })
        .success,
    ).toBe(false);
    expect(
      coachingMessagesSchema.safeParse({
        thread,
        messages: [{ ...message, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});
