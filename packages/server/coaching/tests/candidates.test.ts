import { describe, expect, it } from 'vitest';
import { projectTrainingCandidateV1 } from '../src/candidates.js';
import type { TrainingCoachingBasisV1 } from '@workout/contracts/coaching-basis';
import type { PlanDraft, PlanSnapshot } from '@workout/contracts/planning';
import type { SessionCompletion } from '@workout/contracts/session-completion';

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const date = '2026-09-20';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture item missing');
  return value;
}
function plan(): PlanSnapshot {
  return {
    id: planId,
    version: 1,
    createdAt: '2026-09-18T00:00:00Z',
    draft: {
      title: 'Synthetic plan',
      timezone: 'UTC',
      periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
        id: level,
        parentId: index === 0 ? null : (levels[index - 1] ?? null),
        level,
        title: level,
        startDate: '2026-09-18',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: 'Preserve consistency',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'session',
          blockId: 'block',
          date,
          localStartTime: null,
          title: 'Synthetic run',
          sport: 'running',
          durationSeconds: 3600,
          distanceMeters: 10000,
          targetRpe: null,
          purpose: 'Endurance',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  };
}
function basis(): TrainingCoachingBasisV1 {
  return {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: 'synthetic-owner',
    evidenceSnapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    conversationRevision: 1,
    planVersionId: planId,
    dependencies: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: 'synthetic-owner',
      capturedAt: '2026-09-18T00:00:00Z',
      trainingPlan: { kind: 'exists', versionId: planId },
      activities: { count: '0', revisionSum: '0' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
      aiConsent: { kind: 'exists', revision: 1, granted: true },
    },
    policy: { id: 'synthetic-training', version: '1' },
    retrieval: { kind: 'none' },
  };
}
const strategy = {
  summary: 'Synthetic alternative',
  preservedIntent: 'Keep the original endurance purpose',
  rationale: 'Fixture-only plan comparison',
  unconfirmedInformation: ['Actual recovery is unknown'],
  revisitWhen: 'Review before the session',
};
function input(proposed: PlanDraft, overrides: Record<string, unknown> = {}) {
  return {
    basis: basis(),
    before: plan(),
    proposed,
    strategy,
    asOfLocalDate: '2026-09-18',
    completions: [],
    ...overrides,
  };
}
function projected(value: unknown) {
  const result = projectTrainingCandidateV1(value);
  if (!result.ok) throw new Error(result.reason);
  return result.draft;
}
function completion(): SessionCompletion {
  return {
    sessionId: 'session',
    revision: 1,
    planVersionId: planId,
    schedule: { blockId: 'block', date, localStartTime: null, timezone: 'UTC' },
    status: 'completed',
    reportedAt: '2026-09-18T00:00:00Z',
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
}

describe('M1-05j1 pure training candidate projection', () => {
  it('keeps exact/range/null separate and emits a bounded target impact, not actuals', () => {
    const proposed = structuredClone(plan().draft);
    const session = proposed.sessions[0];
    if (!session) throw new Error('Fixture session missing');
    session.durationSeconds = null;
    session.durationRange = { minSeconds: 3000, maxSeconds: 4200 };
    session.distanceMeters = null;
    const draft = projected(input(proposed));
    expect(draft.diff.sessionChanges).toHaveLength(1);
    expect(draft.diff.duration).toEqual({
      before: { unit: 's', knownMin: 3600, knownMax: 3600, unknownSessionIds: [] },
      after: { unit: 's', knownMin: 3000, knownMax: 4200, unknownSessionIds: [] },
      delta: { unit: 's', min: -600, max: 600 },
    });
    expect(draft.diff.distance).toEqual({
      before: { unit: 'm', knownMin: 10000, knownMax: 10000, unknownSessionIds: [] },
      after: { unit: 'm', knownMin: 0, knownMax: 0, unknownSessionIds: ['session'] },
      delta: null,
    });
    expect(draft.validation.status).toBe('uncertain');
    expect(draft.validation.unknowns).toContainEqual({
      code: 'TARGET_UNKNOWN',
      subject: { kind: 'session', id: 'session' },
    });
  });

  it('reports a locked date and a completed session move as distinct errors', () => {
    const before = plan();
    const original = before.draft.sessions[0];
    if (!original) throw new Error('Fixture session missing');
    original.locks.date = true;
    const proposed = structuredClone(before.draft);
    const changed = proposed.sessions[0];
    if (!changed) throw new Error('Fixture session missing');
    changed.date = '2026-09-21';
    const dependency = basis();
    dependency.dependencies.sessionCompletions = { kind: 'exists', revision: 1 };
    const draft = projected(
      input(proposed, { before, basis: dependency, completions: [completion()] }),
    );
    expect(draft.validation.errors.map((item) => item.code)).toEqual([
      'SESSION_LOCKED',
      'COMPLETED_SESSION_CHANGED',
    ]);
    expect(draft.validation.status).toBe('invalid');
  });

  it('distinguishes new unavailable-date and time-limit conflicts from an uncertain range', () => {
    const before = plan();
    required(before.draft.periods[3]).constraints = {
      unavailableDates: ['2026-09-21'],
      dailyTimeLimits: [{ date, availableSeconds: 4000 }],
    };
    const proposed = structuredClone(before.draft);
    required(proposed.sessions[0]).date = '2026-09-21';
    let draft = projected(input(proposed, { before }));
    expect(draft.validation.errors.map((item) => item.code)).toContain('CONSTRAINT_UNAVAILABLE');
    const range = structuredClone(before.draft);
    required(range.sessions[0]).durationSeconds = null;
    required(range.sessions[0]).durationRange = { minSeconds: 3600, maxSeconds: 4200 };
    draft = projected(input(range, { before }));
    expect(draft.validation.errors).toEqual([]);
    expect(draft.validation.unknowns.map((item) => item.code)).toContain(
      'CONSTRAINT_TIME_UNCERTAIN',
    );
  });

  it('rejects no-op and past edits while allowing a period intent diff', () => {
    const unchanged = projected(input(plan().draft));
    expect(unchanged.validation.errors[0]?.code).toBe('NO_CHANGE');
    const proposed = structuredClone(plan().draft);
    required(proposed.sessions[0]).title = 'Different title';
    expect(
      projected(input(proposed, { asOfLocalDate: '2026-09-21' })).validation.errors,
    ).toContainEqual({ code: 'PAST_SESSION_CHANGED', subject: { kind: 'session', id: 'session' } });
    const periodDraft = structuredClone(plan().draft);
    required(periodDraft.periods[3]).intent = 'Different purpose';
    const period = projected(input(periodDraft));
    expect(period.diff.periodChanges).toHaveLength(1);
    expect(period.validation.status).toBe('checked');
  });

  it('blocks retroactive period schedule or constraint changes while keeping the date in the draft', () => {
    const before = plan();
    required(before.draft.periods[3]).startDate = '2026-09-17';
    required(before.draft.periods[2]).startDate = '2026-09-17';
    required(before.draft.periods[1]).startDate = '2026-09-17';
    required(before.draft.periods[0]).startDate = '2026-09-17';
    const proposed = structuredClone(before.draft);
    required(proposed.periods[3]).endDateExclusive = '2026-09-30';
    const draft = projected(input(proposed, { before }));
    expect(draft.asOfLocalDate).toBe('2026-09-18');
    expect(draft.validation.errors.map((item) => item.code)).toContain('PAST_PERIOD_CHANGED');
  });

  it('catches a future period moved into the past even when its old start is future', () => {
    const proposed = structuredClone(plan().draft);
    for (const period of proposed.periods) period.startDate = '2026-09-17';
    const draft = projected(input(proposed));
    expect(
      draft.validation.errors.filter((item) => item.code === 'PAST_PERIOD_CHANGED'),
    ).toHaveLength(4);
  });

  it('keeps completed schedules protected across plan versions and ignores retracted historical reports', () => {
    const before = plan();
    const dependency = basis();
    dependency.dependencies.sessionCompletions = { kind: 'exists', revision: 2 };
    const priorReport = {
      ...completion(),
      planVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };
    const proposed = structuredClone(before.draft);
    required(proposed.sessions[0]).title = 'Retitled future session';
    expect(
      projected(input(proposed, { before, basis: dependency, completions: [priorReport] }))
        .validation.errors,
    ).toEqual([]);
    required(proposed.sessions[0]).date = '2026-09-21';
    expect(
      projected(input(proposed, { before, basis: dependency, completions: [priorReport] }))
        .validation.errors,
    ).toContainEqual({
      code: 'COMPLETED_SESSION_CHANGED',
      subject: { kind: 'session', id: 'session' },
    });
    const removed = structuredClone(before.draft);
    removed.sessions = [];
    expect(
      projected(input(removed, { before, basis: dependency, completions: [priorReport] }))
        .validation.errors,
    ).toContainEqual({
      code: 'COMPLETED_SESSION_CHANGED',
      subject: { kind: 'session', id: 'session' },
    });
    const retracted = {
      ...priorReport,
      sessionId: 'removed-session',
      revision: 2,
      status: 'retracted' as const,
      reason: 'User retracted the report',
    };
    const renamed = structuredClone(before.draft);
    required(renamed.sessions[0]).title = 'Retitled future session';
    expect(
      projectTrainingCandidateV1(
        input(renamed, { before, basis: dependency, completions: [retracted] }),
      ).ok,
    ).toBe(true);
  });

  it('fails closed on malformed input, mismatched head and incomplete completion basis', () => {
    expect(
      projectTrainingCandidateV1({ ...input(plan().draft), proposed: { sessions: [] } }),
    ).toEqual({ ok: false, reason: 'INVALID_INPUT' });
    expect(
      projectTrainingCandidateV1(
        input(plan().draft, {
          before: { ...plan(), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        }),
      ),
    ).toEqual({ ok: false, reason: 'PLAN_VERSION_MISMATCH' });
    expect(
      projectTrainingCandidateV1(input(plan().draft, { completions: [completion()] })),
    ).toEqual({ ok: false, reason: 'INVALID_COMPLETION_BASIS' });
  });
});
