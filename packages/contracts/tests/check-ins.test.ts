import { describe, expect, it } from 'vitest';
import {
  checkInCreateSchema,
  checkInUpdateSchema,
  checkInListQuerySchema,
  checkInListSchema,
  checkInDefinition,
} from '../src/check-ins.js';

const values = {
  observedAt: '2026-09-16T00:30:00+09:00',
  timezone: 'Asia/Seoul',
  fatigue: 0,
  discomfort: null,
  bodyLocation: null,
  note: null,
};
describe('V2-F17 self-report boundaries', () => {
  it('keeps explicit zero distinct from an unanswered scale and disallows fabricated provenance', () => {
    const input = { idempotencyKey: 'fixture-key-1', values };
    expect(checkInCreateSchema.parse(input).values).toEqual(values);
    expect(checkInCreateSchema.safeParse({ ...input, source: 'garmin' }).success).toBe(false);
    expect(
      checkInCreateSchema.safeParse({ ...input, values: { ...values, method: 'estimated' } })
        .success,
    ).toBe(false);
    expect(checkInDefinition.fatigue.low).toBe('피로 없음');
    expect(checkInDefinition.discomfort.low).toBe('불편감 없음');
  });
  it('rejects empty, noninteger, out of range and invalid calendar/timezone input', () => {
    for (const change of [
      { fatigue: null },
      { fatigue: 11 },
      { fatigue: -1 },
      { fatigue: 1.5 },
      { timezone: 'Mars/Olympus' },
      { observedAt: '2026-09-16T00:30:00' },
      { note: '  ' },
    ])
      expect(
        checkInCreateSchema.safeParse({
          idempotencyKey: 'fixture-key-1',
          values: { ...values, ...change },
        }).success,
      ).toBe(false);
    expect(
      checkInCreateSchema.safeParse({
        idempotencyKey: 'fixture-key-1',
        values: { ...values, fatigue: null, note: '사용자가 보고한 메모' },
      }).success,
    ).toBe(true);
  });
  it('requires the observed revision and reason for a complete correction', () => {
    const update = {
      idempotencyKey: 'fixture-key-2',
      expectedRevision: 1,
      reason: '잘못 입력한 값 정정',
      values,
    };
    expect(checkInUpdateSchema.safeParse(update).success).toBe(true);
    expect(checkInUpdateSchema.safeParse({ ...update, expectedRevision: 0 }).success).toBe(false);
    expect(checkInUpdateSchema.safeParse({ ...update, reason: '' }).success).toBe(false);
    expect(checkInUpdateSchema.safeParse({ ...update, values: { fatigue: 5 } }).success).toBe(
      false,
    );
  });
  it('bounds local date windows including leap days, preserving an absent collection head as revision zero', () => {
    expect(
      checkInListQuerySchema.parse({ from: '2024-02-29', toExclusive: '2024-03-01' }),
    ).toMatchObject({ limit: 50, offset: 0 });
    for (const range of [
      { from: '2025-02-29', toExclusive: '2025-03-01' },
      { from: '2026-01-01', toExclusive: '2026-01-01' },
      { from: '2026-01-01', toExclusive: '2026-04-02' },
      { from: '2026-01-01', toExclusive: '2026-01-02', limit: 101 },
    ])
      expect(checkInListQuerySchema.safeParse(range).success).toBe(false);
    expect(checkInListSchema.parse({ items: [], total: 0, collectionRevision: 0 })).toEqual({
      items: [],
      total: 0,
      collectionRevision: 0,
    });
  });
});
