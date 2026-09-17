import { describe, expect, it } from 'vitest';
import {
  coachingConstraintSchema,
  coachingConstraintListSchema,
  coachingConstraintCreateSchema,
  coachingConstraintUpdateSchema,
  coachingConstraintDeleteSchema,
  coachingConstraintCommandResultSchema,
} from '../src/coaching-constraints.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entry = {
  id,
  revision: 1,
  text: '사용자가 확인한 제약',
  confirmedAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
};
const create = {
  expectedHeadRevision: null,
  confirmed: true,
  text: entry.text,
  idempotencyKey: 'key',
};
describe('confirmed user constraint contracts', () => {
  it('distinguishes unconfirmed absence from explicitly cleared existing ledger', () => {
    expect(coachingConstraintListSchema.parse({ headRevision: null, items: [] })).toEqual({
      headRevision: null,
      items: [],
    });
    expect(coachingConstraintListSchema.parse({ headRevision: 2, items: [] })).toEqual({
      headRevision: 2,
      items: [],
    });
    expect(
      coachingConstraintListSchema.safeParse({ headRevision: null, items: [entry] }).success,
    ).toBe(false);
  });
  it('canonicalizes confirmed text and accepts explicit create/update/delete commands', () => {
    expect(
      coachingConstraintCreateSchema.parse({ ...create, text: '  직접 확인\n한 문장  ' }).text,
    ).toBe('직접 확인\n한 문장');
    expect(
      coachingConstraintUpdateSchema.safeParse({
        ...create,
        expectedHeadRevision: 1,
        expectedRevision: 1,
      }).success,
    ).toBe(true);
    const { text: _text, ...deletion } = create;
    expect(_text).toBe(entry.text);
    expect(
      coachingConstraintDeleteSchema.safeParse({
        ...deletion,
        expectedHeadRevision: 1,
        expectedRevision: 1,
      }).success,
    ).toBe(true);
  });
  it.each(['', ' \n ', 'x\0y', 'x'.repeat(2001)])('rejects invalid text %j', (text) => {
    expect(coachingConstraintCreateSchema.safeParse({ ...create, text }).success).toBe(false);
    expect(coachingConstraintSchema.safeParse({ ...entry, text }).success).toBe(false);
  });
  it.each([0, -1, 1.5, 2147483647, NaN, Infinity])('rejects invalid revision %s', (revision) => {
    expect(coachingConstraintSchema.safeParse({ ...entry, revision }).success).toBe(false);
    expect(
      coachingConstraintCreateSchema.safeParse({ ...create, expectedHeadRevision: revision })
        .success,
    ).toBe(false);
  });
  it('requires explicit confirmation and rejects implicit/malformed ownership or identity', () => {
    for (const patch of [
      { confirmed: false },
      { confirmed: undefined },
      { athleteId: 'foreign' },
      { idempotencyKey: ' key' },
      { idempotencyKey: 'key\0' },
      { idempotencyKey: 'x'.repeat(201) },
      { expectedHeadRevision: undefined },
    ])
      expect(coachingConstraintCreateSchema.safeParse({ ...create, ...patch }).success).toBe(false);
    expect(coachingConstraintSchema.safeParse({ ...entry, id: id.toUpperCase() }).success).toBe(
      false,
    );
    expect(coachingConstraintSchema.safeParse({ ...entry, confirmedAt: 'today' }).success).toBe(
      false,
    );
    expect(
      coachingConstraintUpdateSchema.safeParse({ ...create, expectedRevision: 1 }).success,
    ).toBe(false);
    expect(
      coachingConstraintDeleteSchema.safeParse({
        ...create,
        expectedHeadRevision: 1,
        expectedRevision: 1,
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate IDs and limits active entries to50', () => {
    expect(
      coachingConstraintListSchema.safeParse({ headRevision: 2, items: [entry, entry] }).success,
    ).toBe(false);
    const items = Array.from({ length: 50 }, (_, i) => ({
      ...entry,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(coachingConstraintListSchema.safeParse({ headRevision: 50, items }).success).toBe(true);
    expect(
      coachingConstraintListSchema.safeParse({ headRevision: 51, items: [...items, entry] })
        .success,
    ).toBe(false);
  });
  it('returns metadata only for mutations', () => {
    const result = { id, revision: 2, headRevision: 3, deleted: true };
    expect(coachingConstraintCommandResultSchema.parse(result)).toEqual(result);
    expect(
      coachingConstraintCommandResultSchema.safeParse({ ...result, text: 'private' }).success,
    ).toBe(false);
    expect(
      coachingConstraintCommandResultSchema.safeParse({ ...result, headRevision: null }).success,
    ).toBe(false);
  });
});
