import { describe, expect, it, vi } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import { duplicatePlannedSession } from '../src/duplicate-session';
function fixture(): PlanDraft {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  return {
    title: 'Draft',
    timezone: 'UTC',
    periods: levels.map((level, i) => ({
      id: level,
      parentId: i === 0 ? null : (levels[i - 1] ?? null),
      level,
      title: level,
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-01-01',
        localStartTime: null,
        title: 'Original',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: 0,
        purpose: 'Purpose',
        notes: 'Notes',
        priority: 'high',
        locks: { date: true, time: true, intensity: true },
        steps: [
          {
            id: 'step-a',
            kind: 'warmup',
            durationSeconds: 0,
            distanceMeters: null,
            repetitions: 1,
          },
          { id: 'step-b', kind: 'work', durationSeconds: null, distanceMeters: 0, repetitions: 2 },
        ],
      },
    ],
  };
}
const generator = () => {
  let id = 0;
  return vi.fn(() => `copy-${++id}`);
};
describe('duplicate planned session', () => {
  it('preserves unrelated editor text even when validation would trim it', () => {
    const draft = fixture();
    draft.title = ' Draft in progress ';
    const source = draft.sessions[0];
    if (!source) throw new Error('Missing fixture');
    source.title = ' Original ';
    const result = duplicatePlannedSession(draft, source.id, generator());
    if (!result.ok) throw new Error(result.error);
    expect(result.draft.title).toBe(draft.title);
    expect(result.draft.periods).toEqual(draft.periods);
    expect(result.draft.sessions[0]).toEqual(source);
    expect(planDraftSchema.safeParse(result.draft).success).toBe(true);
  });
  it('creates a valid independently owned session and step IDs, preserving values and the locked source', () => {
    const original = fixture(),
      before = JSON.stringify(original),
      createId = generator();
    const result = duplicatePlannedSession(original, 'session', createId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createId).toHaveBeenCalledTimes(3);
    expect(result.sessionId).toBe('copy-1');
    expect(planDraftSchema.safeParse(result.draft).success).toBe(true);
    const source = result.draft.sessions[0],
      copy = result.draft.sessions[1];
    if (!source || !copy) throw new Error('Missing records');
    expect(copy).toEqual({
      ...source,
      id: 'copy-1',
      title: 'Original 복사',
      locks: { date: false, time: false, intensity: false, attendance: false },
      steps: source.steps.map((step, i) => ({ ...step, id: `copy-${i + 2}` })),
    });
    expect(source.locks).toEqual({ date: true, time: true, intensity: true });
    expect(JSON.stringify(original)).toBe(before);
    expect(result.draft.periods).not.toBe(original.periods);
    expect(source).not.toBe(original.sessions[0]);
    expect(copy.locks).not.toBe(source.locks);
    expect(copy.steps).not.toBe(source.steps);
    expect(copy.steps[0]).not.toBe(source.steps[0]);
    copy.notes = 'Changed copy';
    const copiedStep = copy.steps[0];
    if (!copiedStep) throw new Error('Missing step');
    copiedStep.repetitions = 9;
    expect(source.notes).toBe('Notes');
    expect(source.steps[0]?.repetitions).toBe(1);
    expect(JSON.stringify(original)).toBe(before);
  });
  it.each([197, 198, 200])(
    'keeps title within the exact 200-character limit for length %s',
    (length) => {
      const draft = fixture();
      const source = draft.sessions[0];
      if (!source) throw new Error('Missing session');
      source.title = '가'.repeat(length);
      const result = duplicatePlannedSession(draft, 'session', generator());
      if (!result.ok) throw new Error(result.error);
      expect(result.draft.sessions[1]?.title).toBe(
        length + 3 <= 200 ? '가'.repeat(length) + ' 복사' : '가'.repeat(length),
      );
    },
  );
  it('rejects capacity before generating any IDs', () => {
    const draft = fixture(),
      source = draft.sessions[0];
    if (!source) throw new Error('Missing fixture');
    draft.sessions = Array.from({ length: 1000 }, (_, i) => ({
      ...source,
      id: `session-${i}`,
      steps: [],
    }));
    const createId = generator();
    expect(duplicatePlannedSession(draft, 'session-0', createId)).toEqual({
      ok: false,
      error: 'capacity',
    });
    expect(createId).not.toHaveBeenCalled();
  });
  it('rejects invalid drafts and missing sessions without consuming IDs', () => {
    const draft = fixture(),
      createId = generator();
    const source = draft.sessions[0];
    if (!source) throw new Error('Missing session');
    source.date = '2026-03-01';
    expect(duplicatePlannedSession(draft, 'session', createId)).toEqual({
      ok: false,
      error: 'invalid_draft',
    });
    expect(duplicatePlannedSession(fixture(), 'missing', createId)).toEqual({
      ok: false,
      error: 'missing_session',
    });
    expect(createId).not.toHaveBeenCalled();
  });
  it.each(['', '   ', ' padded', 'x'.repeat(201)])(
    'rejects invalid generated IDs without modifying the draft',
    (id) => {
      const draft = fixture(),
        before = JSON.stringify(draft);
      expect(duplicatePlannedSession(draft, 'session', () => id)).toEqual({
        ok: false,
        error: 'invalid_id',
      });
      expect(JSON.stringify(draft)).toBe(before);
    },
  );
  it.each(['season', 'session', 'step-a'])(
    'rejects collisions with any existing ID namespace (%s)',
    (id) => {
      const createId = vi.fn(() => id);
      expect(duplicatePlannedSession(fixture(), 'session', createId)).toEqual({
        ok: false,
        error: 'id_collision',
      });
      expect(createId).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects collisions among generated step/session IDs without retries or partial writes', () => {
    const draft = fixture(),
      before = JSON.stringify(draft),
      createId = vi.fn(() => 'same-new-id');
    expect(duplicatePlannedSession(draft, 'session', createId)).toEqual({
      ok: false,
      error: 'id_collision',
    });
    expect(createId).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(draft)).toBe(before);
  });
  it('validates every generated step ID and handles generator failure', () => {
    const createId = vi.fn().mockReturnValueOnce('new-session').mockReturnValueOnce(' invalid');
    expect(duplicatePlannedSession(fixture(), 'session', createId)).toEqual({
      ok: false,
      error: 'invalid_id',
    });
    expect(
      duplicatePlannedSession(fixture(), 'session', () => {
        throw new Error('Unavailable random');
      }),
    ).toEqual({ ok: false, error: 'invalid_id' });
  });
});
