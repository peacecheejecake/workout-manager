import { describe, expect, it } from 'vitest';
import {
  planSnapshotSchema,
  type PeriodDraft,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import { comparePlanHistory } from '../src/plan-history-comparison';

function period(
  id: string,
  parentId: string | null,
  level: PeriodDraft['level'],
  startDate: string,
  endDateExclusive: string,
): PeriodDraft {
  return {
    id,
    parentId,
    level,
    title: id,
    startDate,
    endDateExclusive,
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  };
}
function fixture(): PlanSnapshot {
  return planSnapshotSchema.parse({
    id: 'version-one',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    draft: {
      title: '훈련 계획',
      timezone: 'UTC',
      periods: [
        period('season', null, 'season', '2026-01-01', '2026-02-01'),
        period('wave', 'season', 'wave', '2026-01-01', '2026-02-01'),
        period('phase-a', 'wave', 'phase', '2026-01-01', '2026-01-15'),
        period('phase-b', 'wave', 'phase', '2026-01-15', '2026-02-01'),
        period('block-a', 'phase-a', 'block', '2026-01-02', '2026-01-04'),
        period('block-b', 'phase-b', 'block', '2026-01-20', '2026-01-22'),
      ],
      sessions: ['a', 'b'].map((id) => ({
        id: `session-${id}`,
        blockId: `block-${id}`,
        date: id === 'a' ? '2026-01-02' : '2026-01-20',
        localStartTime: null,
        title: '같은 제목',
        sport: 'running',
        durationSeconds: 0,
        distanceMeters: null,
        targetRpe: 0,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [
          {
            id: `step-${id}-one`,
            kind: 'warmup',
            durationSeconds: 0,
            distanceMeters: null,
            repetitions: 1,
          },
          {
            id: `step-${id}-two`,
            kind: 'work',
            durationSeconds: null,
            distanceMeters: 0,
            repetitions: 2,
          },
        ],
      })),
    },
  });
}
function next(before: PlanSnapshot, edit: (draft: PlanSnapshot['draft']) => void): PlanSnapshot {
  const result = structuredClone(before);
  result.id = 'version-two';
  result.version = 2;
  edit(result.draft);
  return planSnapshotSchema.parse(result);
}
function session(snapshot: PlanSnapshot, id = 'session-a') {
  const result = snapshot.draft.sessions.find((item) => item.id === id);
  if (!result) throw new Error('Missing fixture session');
  return result;
}

describe('immutable plan history comparison', () => {
  it('compares whole plans by default without mutating snapshots or counting versions as content changes', () => {
    const before = fixture();
    const after = next(before, () => {});
    const originals = structuredClone([before, after]);
    const model = comparePlanHistory(before, after);
    expect(model.scope.status).toBe('wholePlan');
    expect(model.periods).toHaveLength(6);
    expect(model.sessions).toHaveLength(2);
    expect(model.periods.every((row) => row.status === 'unchanged')).toBe(true);
    expect(model.sessions.every((row) => row.status === 'unchanged' && row.movement === null)).toBe(
      true,
    );
    expect(model.planMetadata.changed).toBe(false);
    expect([before, after]).toEqual(originals);
  });

  it('uses exact IDs even when replacement periods and sessions have identical dates and titles', () => {
    const before = fixture();
    const after = next(before, (draft) => {
      const block = draft.periods.find((item) => item.id === 'block-a');
      if (!block) throw new Error('Missing block');
      block.id = 'new-block';
      const first = draft.sessions[0];
      if (!first) throw new Error('Missing session');
      first.id = 'new-session';
      first.blockId = 'new-block';
    });
    const model = comparePlanHistory(before, after, 'phase-a');
    expect(model.periodOptions.find((item) => item.id === 'block-a')).toMatchObject({
      presence: 'beforeOnly',
      beforeTitle: 'block-a',
      afterTitle: null,
    });
    expect(model.periodOptions.find((item) => item.id === 'new-block')).toMatchObject({
      presence: 'afterOnly',
      beforeTitle: null,
      afterTitle: 'block-a',
    });
    expect(model.sessions.map((row) => [row.id, row.status, row.movement])).toEqual([
      ['session-a', 'removed', null],
      ['new-session', 'added', null],
    ]);
  });

  it('distinguishes moving out from deletion when the selected period no longer exists', () => {
    const before = fixture();
    before.draft.sessions.push({ ...structuredClone(session(before)), id: 'deleted-session' });
    const after = next(before, (draft) => {
      draft.periods = draft.periods.filter((item) => item.id !== 'block-a');
      draft.sessions = draft.sessions.filter((item) => item.id !== 'deleted-session');
      const first = draft.sessions[0];
      if (!first) throw new Error('Missing session');
      first.blockId = 'block-b';
      first.date = '2026-01-20';
    });
    const model = comparePlanHistory(before, after, 'block-a');
    expect(model.scope.status).toBe('beforeOnly');
    expect(model.scope.after).toBeNull();
    expect(model.sessions.find((row) => row.id === 'session-a')).toMatchObject({
      status: 'changed',
      movement: 'outOfScope',
      beforeInScope: true,
      afterInScope: false,
      after: { blockId: 'block-b' },
    });
    expect(model.sessions.find((row) => row.id === 'deleted-session')).toMatchObject({
      status: 'removed',
      movement: null,
      after: null,
    });
    const reverse = comparePlanHistory(after, before, 'block-a');
    expect(reverse.scope.status).toBe('afterOnly');
    expect(reverse.sessions.find((row) => row.id === 'session-a')).toMatchObject({
      status: 'changed',
      movement: 'intoScope',
      beforeInScope: false,
      afterInScope: true,
    });
    expect(reverse.sessions.find((row) => row.id === 'deleted-session')).toMatchObject({
      status: 'added',
      movement: null,
      before: null,
    });
  });

  it('resolves each hierarchy independently and reports moved unchanged sessions without inventing session edits', () => {
    const before = fixture();
    const after = next(before, (draft) => {
      draft.periods = draft.periods.map((item) =>
        item.id === 'phase-a'
          ? { ...item, startDate: '2026-01-15', endDateExclusive: '2026-02-01' }
          : item.id === 'phase-b'
            ? { ...item, startDate: '2026-01-01', endDateExclusive: '2026-01-15' }
            : item.id === 'block-a'
              ? { ...item, parentId: 'phase-b' }
              : item.id === 'block-b'
                ? { ...item, parentId: 'phase-a' }
                : item,
      );
    });
    const model = comparePlanHistory(before, after, 'phase-a');
    expect(model.periods.map((row) => row.id)).toEqual(['phase-a', 'block-a', 'block-b']);
    expect(model.periods.find((row) => row.id === 'block-a')).toMatchObject({
      status: 'changed',
      movement: 'outOfScope',
      before: { parentId: 'phase-a' },
      after: { parentId: 'phase-b' },
    });
    expect(model.sessions.map((row) => [row.id, row.status, row.movement])).toEqual([
      ['session-a', 'unchanged', 'outOfScope'],
      ['session-b', 'unchanged', 'intoScope'],
    ]);
    expect(
      comparePlanHistory(before, after, 'wave').sessions.every((row) => row.movement === null),
    ).toBe(true);
  });

  it('does not fall back to all periods or similarly named periods for an absent ID', () => {
    const before = fixture();
    const model = comparePlanHistory(before, before, 'absent');
    expect(model.scope).toEqual({ status: 'missing', before: null, after: null });
    expect(model.sessions).toEqual([]);
    expect(model.periods).toEqual([]);
    expect(model.periodOptions).toHaveLength(6);
  });

  it('preserves metadata, purpose, partial status and timezone changes', () => {
    const before = fixture();
    const after = next(before, (draft) => {
      draft.title = '수정 계획';
      draft.timezone = 'Asia/Seoul';
      draft.periods = draft.periods.map((item) => ({
        ...item,
        timezone: 'Asia/Seoul',
        ...(item.id === 'phase-a'
          ? { title: '새 목적 기간', intent: '목적 변경', isPartial: true }
          : {}),
      }));
      const first = draft.sessions[0];
      if (!first) throw new Error('Missing session');
      first.purpose = '세션 목적';
      first.notes = '메모';
      first.priority = 'high';
      first.locks.intensity = true;
    });
    const model = comparePlanHistory(before, after, 'phase-a');
    expect(model.planMetadata).toEqual({
      before: { title: '훈련 계획', timezone: 'UTC' },
      after: { title: '수정 계획', timezone: 'Asia/Seoul' },
      changed: true,
    });
    expect(model.periodOptions.find((item) => item.id === 'phase-a')).toMatchObject({
      title: '새 목적 기간',
      beforeTitle: 'phase-a',
      afterTitle: '새 목적 기간',
      presence: 'shared',
    });
    expect(model.periods.find((row) => row.id === 'phase-a')).toMatchObject({
      status: 'changed',
      after: { intent: '목적 변경', isPartial: true, timezone: 'Asia/Seoul' },
    });
    expect(model.sessions[0]).toMatchObject({
      status: 'changed',
      after: { purpose: '세션 목적', notes: '메모', priority: 'high', locks: { intensity: true } },
    });
  });

  it('preserves step order and treats null and zero as different values', () => {
    const before = fixture();
    const after = next(before, (draft) => {
      const first = draft.sessions[0];
      if (!first) throw new Error('Missing session');
      first.steps.reverse();
      first.distanceMeters = 0;
      first.durationSeconds = null;
    });
    const row = comparePlanHistory(before, after, 'block-a').sessions[0];
    expect(row?.status).toBe('changed');
    expect(row?.before?.steps.map((step) => step.id)).toEqual(['step-a-one', 'step-a-two']);
    expect(row?.after?.steps.map((step) => step.id)).toEqual(['step-a-two', 'step-a-one']);
    expect(row?.before).toMatchObject({ distanceMeters: null, durationSeconds: 0, targetRpe: 0 });
    expect(row?.after).toMatchObject({ distanceMeters: 0, durationSeconds: null, targetRpe: 0 });
    const onlyReordered = next(before, (draft) => {
      draft.sessions.forEach((item) => {
        if (item.id === 'session-a') item.steps.reverse();
      });
    });
    expect(comparePlanHistory(before, onlyReordered, 'block-a').sessions[0]?.status).toBe(
      'changed',
    );
  });

  it.each([null, 'A'] as const)(
    'preserves legacy absence separately from explicit intensity label %s',
    (label) => {
      const before = fixture();
      const after = next(before, (draft) => {
        draft.sessions.forEach((item) => {
          if (item.id === 'session-a') item.intensityLabel = label;
        });
      });
      const row = comparePlanHistory(before, after, 'block-a').sessions[0];
      expect(row?.status).toBe('changed');
      expect(row?.before).not.toHaveProperty('intensityLabel');
      expect(row?.after).toHaveProperty('intensityLabel', label);
    },
  );

  it('ignores object property insertion order while retaining full entity values', () => {
    const before = fixture();
    const after = structuredClone(before);
    const first = session(after);
    const { title, ...rest } = first;
    after.draft.sessions[0] = { title, ...rest };
    const row = comparePlanHistory(before, after, 'block-a').sessions[0];
    expect(row?.status).toBe('unchanged');
    expect(row?.after).toEqual(first);
  });
});
