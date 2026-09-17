import { describe, expect, it } from 'vitest';
import { planDraftSchema, type PlanDraft } from '../src/planning.js';
import {
  preservesSessionCompletions,
  sessionCompletionBodySchema,
  sessionCompletionCommandSchema,
  sessionCompletionListSchema,
  sessionCompletionPathSchema,
  sessionCompletionReadSchema,
  sessionCompletionResultSchema,
  sessionCompletionSchema,
  type SessionCompletion,
} from '../src/session-completion.js';

const versionId = '12345678-1234-4123-8123-123456789abc';
const firstCommand = {
  action: 'complete',
  confirmed: true,
  expectedPlanVersionId: versionId,
  expectedRevision: null,
  reason: null,
  idempotencyKey: 'completion-key_01',
} as const;
function report(): SessionCompletion {
  return {
    sessionId: 'session',
    revision: 1,
    planVersionId: versionId,
    schedule: {
      blockId: 'block',
      date: '2024-02-29',
      localStartTime: null,
      timezone: 'America/New_York',
    },
    status: 'completed',
    reportedAt: '2024-03-02T12:00:00+09:00',
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
}
function draft(): PlanDraft {
  return planDraftSchema.parse({
    title: 'Synthetic completion plan',
    timezone: 'America/New_York',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2024-02-27',
      endDateExclusive: '2024-03-04',
      timezone: 'America/New_York',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2024-02-29',
        localStartTime: null,
        title: 'Synthetic session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
}

describe('session completion commands and immutable report wire boundaries', () => {
  it('accepts explicit first confirmation and normalizes only UUID and correction reason', () => {
    expect(sessionCompletionCommandSchema.parse(firstCommand)).toStrictEqual(firstCommand);
    expect(
      sessionCompletionCommandSchema.parse({
        ...firstCommand,
        expectedPlanVersionId: versionId.toUpperCase(),
        expectedRevision: 2,
        reason: '  Synthetic reconfirmation  ',
      }),
    ).toMatchObject({ expectedPlanVersionId: versionId, reason: 'Synthetic reconfirmation' });
    for (const action of ['complete', 'retract']) {
      expect(
        sessionCompletionCommandSchema.safeParse({
          ...firstCommand,
          action,
          expectedRevision: 1,
          reason: 'Explicit correction',
        }).success,
      ).toBe(true);
    }
  });

  it.each([
    { confirmed: false },
    { confirmed: undefined },
    { action: 'skip' },
    { expectedPlanVersionId: 'not-a-version' },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: '1' },
    { expectedRevision: 2147483647 },
    { expectedRevision: 1 },
    { action: 'retract' },
    { action: 'retract', reason: 'No existing report' },
    { reason: '' },
    { reason: '   ' },
    { reason: 'r'.repeat(501) },
    { athleteId: 'client-owner' },
    { reportedAt: '2024-02-29T00:00:00Z' },
    { source: 'device' },
    { schedule: report().schedule },
  ])('rejects invalid or client-owned command fields: %j', (patch) => {
    expect(sessionCompletionCommandSchema.safeParse({ ...firstCommand, ...patch }).success).toBe(
      false,
    );
  });

  it('keeps command idempotency separate from the HTTP body and enforces bounded keys', () => {
    const { idempotencyKey, ...body } = firstCommand;
    expect(idempotencyKey).toBeDefined();
    expect(sessionCompletionBodySchema.parse(body)).toStrictEqual(body);
    expect(sessionCompletionBodySchema.safeParse(firstCommand).success).toBe(false);
    expect(sessionCompletionCommandSchema.safeParse(body).success).toBe(false);
    for (const key of ['a'.repeat(8), 'A_09-'.repeat(25), 'a'.repeat(128)])
      expect(
        sessionCompletionCommandSchema.safeParse({ ...firstCommand, idempotencyKey: key }).success,
      ).toBe(true);
    for (const key of [
      '',
      'short',
      'a'.repeat(129),
      ' spaces ',
      'key/with/slash',
      'key.with.dot',
      '요청식별자',
    ])
      expect(
        sessionCompletionCommandSchema.safeParse({ ...firstCommand, idempotencyKey: key }).success,
      ).toBe(false);
  });

  it('validates stable session paths without coercion or client ownership', () => {
    expect(sessionCompletionPathSchema.parse({ sessionId: 'stable-session:1' })).toEqual({
      sessionId: 'stable-session:1',
    });
    for (const sessionId of ['', '  ', ' session', 'session ', 'x'.repeat(201), 123])
      expect(sessionCompletionPathSchema.safeParse({ sessionId }).success).toBe(false);
    expect(
      sessionCompletionPathSchema.safeParse({ sessionId: 'session', athleteId: 'other' }).success,
    ).toBe(false);
  });

  it('preserves report timing and unknown local time without inventing actual performance', () => {
    const original = report();
    expect(sessionCompletionSchema.parse(original)).toStrictEqual(original);
    expect(
      sessionCompletionSchema.parse({ ...original, planVersionId: versionId.toUpperCase() })
        .planVersionId,
    ).toBe(versionId);
    expect(
      sessionCompletionResultSchema.parse({ report: original, collectionRevision: 1 }),
    ).toStrictEqual({ report: original, collectionRevision: 1 });
    expect(
      sessionCompletionSchema.parse({
        ...original,
        revision: 2,
        status: 'retracted',
        reason: 'Wrong session',
      }),
    ).toMatchObject({ status: 'retracted', revision: 2 });
    expect(
      sessionCompletionSchema.parse({ ...original, revision: 3, reason: 'Confirm again' }),
    ).toMatchObject({ status: 'completed', revision: 3 });
  });

  it.each([
    { revision: 0 },
    { revision: 2147483647 },
    { revision: 2 },
    { status: 'retracted', reason: 'Cannot retract first' },
    { status: 'skipped' },
    { source: 'garmin' },
    { method: 'measurement' },
    { definitionVersion: 'v2' },
    { reason: '' },
    { reportedAt: '2024-03-02T12:00:00' },
    { actualDurationSeconds: 0 },
    { activityId: versionId },
  ])('rejects malformed or fabricated report output: %j', (patch) => {
    expect(sessionCompletionSchema.safeParse({ ...report(), ...patch }).success).toBe(false);
  });

  it('validates nested scheduling identity and strict result revisions', () => {
    for (const patch of [
      { date: '2023-02-29' },
      { localStartTime: '24:00' },
      { timezone: '+09:00' },
      { blockId: '' },
      { actualEnd: '12:00' },
    ])
      expect(
        sessionCompletionSchema.safeParse({
          ...report(),
          schedule: { ...report().schedule, ...patch },
        }).success,
      ).toBe(false);
    for (const collectionRevision of [0, -1, 1.5, '1', 2147483647])
      expect(
        sessionCompletionResultSchema.safeParse({ report: report(), collectionRevision }).success,
      ).toBe(false);
    expect(
      sessionCompletionResultSchema.safeParse({
        report: report(),
        collectionRevision: 1,
        receiptBody: {},
      }).success,
    ).toBe(false);
  });

  it('distinguishes missing and retracted reports and bounds collection/history reads', () => {
    expect(
      sessionCompletionListSchema.parse({
        currentPlanVersionId: null,
        collectionRevision: 0,
        items: [],
      }).items,
    ).toEqual([]);
    const retracted = { ...report(), revision: 2, status: 'retracted', reason: 'Wrong session' };
    expect(
      sessionCompletionListSchema.safeParse({
        currentPlanVersionId: versionId,
        collectionRevision: 2,
        items: [retracted],
      }).success,
    ).toBe(true);
    expect(
      sessionCompletionReadSchema.parse({
        sessionId: 'session',
        currentPlanVersionId: versionId,
        report: null,
        history: [],
        totalHistory: 0,
      }).report,
    ).toBeNull();
    expect(
      sessionCompletionReadSchema.safeParse({
        sessionId: 'session',
        currentPlanVersionId: versionId,
        report: retracted,
        history: [retracted, report()],
        totalHistory: 2,
      }).success,
    ).toBe(true);
    expect(
      sessionCompletionListSchema.safeParse({
        currentPlanVersionId: versionId,
        collectionRevision: 2,
        items: [report(), retracted],
      }).success,
    ).toBe(false);
    expect(
      sessionCompletionListSchema.safeParse({
        currentPlanVersionId: versionId,
        collectionRevision: 1,
        items: Array.from({ length: 1001 }, (_, index) => ({
          ...report(),
          sessionId: `session-${index}`,
        })),
      }).success,
    ).toBe(false);
    const read = {
      sessionId: 'session',
      currentPlanVersionId: versionId,
      report: report(),
      history: [report()],
      totalHistory: 1,
    };
    for (const patch of [
      { sessionId: 'other' },
      { history: [{ ...report(), sessionId: 'other' }] },
      { report: null },
      { totalHistory: 0 },
      { totalHistory: -1 },
      { history: Array.from({ length: 101 }, () => report()), totalHistory: 101 },
      { owner: 'client' },
    ])
      expect(sessionCompletionReadSchema.safeParse({ ...read, ...patch }).success).toBe(false);
  });

  it('rejects collection revisions behind a report and nonempty collections without a saved head', () => {
    const corrected = { ...report(), revision: 3, reason: 'Reconfirmed' };
    expect(
      sessionCompletionResultSchema.safeParse({ report: corrected, collectionRevision: 2 }).success,
    ).toBe(false);
    expect(
      sessionCompletionResultSchema.safeParse({ report: corrected, collectionRevision: 3 }).success,
    ).toBe(true);
    expect(
      sessionCompletionListSchema.safeParse({
        currentPlanVersionId: null,
        collectionRevision: 3,
        items: [corrected],
      }).success,
    ).toBe(false);
    expect(
      sessionCompletionListSchema.safeParse({
        currentPlanVersionId: versionId,
        collectionRevision: 2,
        items: [corrected],
      }).success,
    ).toBe(false);
    expect(
      sessionCompletionListSchema.safeParse({
        currentPlanVersionId: versionId,
        collectionRevision: 3,
        items: [corrected],
      }).success,
    ).toBe(true);
  });

  it('requires complete descending history through the bounded window and the exact latest report', () => {
    const first = report();
    const second = { ...first, revision: 2, status: 'retracted', reason: 'Wrong session' };
    const third = { ...first, revision: 3, reason: 'Reconfirmed' };
    const read = {
      sessionId: 'session',
      currentPlanVersionId: versionId,
      report: third,
      history: [third, second, first],
      totalHistory: 3,
    };
    expect(sessionCompletionReadSchema.safeParse(read).success).toBe(true);
    for (const patch of [
      { totalHistory: 4 },
      { history: [third, first] },
      { history: [first, second, third] },
      { history: [third, second, second] },
      { history: [{ ...third, reason: 'Different receipt' }, second, first] },
      {
        history: [
          { ...third, schedule: { ...third.schedule, localStartTime: '09:00' } },
          second,
          first,
        ],
      },
      { report: first, history: [], totalHistory: 0 },
    ])
      expect(sessionCompletionReadSchema.safeParse({ ...read, ...patch }).success).toBe(false);
    const latest = { ...third, revision: 105 };
    const history = Array.from({ length: 100 }, (_, index) => ({
      ...latest,
      revision: 105 - index,
    }));
    expect(
      sessionCompletionReadSchema.safeParse({ ...read, report: latest, history, totalHistory: 105 })
        .success,
    ).toBe(true);
    expect(
      sessionCompletionReadSchema.safeParse({
        ...read,
        report: latest,
        history: history.slice(0, 99),
        totalHistory: 105,
      }).success,
    ).toBe(false);
  });
});

describe('active completion schedule preservation', () => {
  const changes: { label: string; change(plan: PlanDraft): PlanDraft }[] = [
    {
      label: 'date',
      change: (plan) => ({
        ...plan,
        sessions: plan.sessions.map((session) => ({ ...session, date: '2024-03-01' })),
      }),
    },
    {
      label: 'local time',
      change: (plan) => ({
        ...plan,
        sessions: plan.sessions.map((session) => ({ ...session, localStartTime: '00:00' })),
      }),
    },
    {
      label: 'Block',
      change: (plan) => ({
        ...plan,
        sessions: plan.sessions.map((session) => ({ ...session, blockId: 'other-block' })),
      }),
    },
    { label: 'timezone', change: (plan) => ({ ...plan, timezone: 'UTC' }) },
    { label: 'deletion', change: (plan) => ({ ...plan, sessions: [] }) },
  ];
  it.each(changes)('blocks $label only while the confirmation is active', ({ change }) => {
    const plan = draft();
    const changed = change(plan);
    expect(preservesSessionCompletions(plan, [report()])).toBe(true);
    expect(preservesSessionCompletions(changed, [report()])).toBe(false);
    expect(
      preservesSessionCompletions(changed, [
        { ...report(), revision: 2, status: 'retracted', reason: 'Explicitly retract' },
      ]),
    ).toBe(true);
    expect(preservesSessionCompletions(changed, [])).toBe(true);
  });

  it('does not inherit completion through a clone ID or substitute the clone for its original', () => {
    const plan = draft();
    const clones = plan.sessions.map((session) => ({
      ...session,
      id: 'new-clone',
      date: '2024-03-02',
      localStartTime: '08:00',
    }));
    expect(
      preservesSessionCompletions({ ...plan, sessions: [...plan.sessions, ...clones] }, [report()]),
    ).toBe(true);
    expect(preservesSessionCompletions({ ...plan, sessions: clones }, [report()])).toBe(false);
  });

  it('keeps confirmed timing exact and does not turn null into midnight', () => {
    const plan = draft();
    const timedReport = {
      ...report(),
      schedule: { ...report().schedule, localStartTime: '08:30' },
    };
    expect(preservesSessionCompletions(plan, [timedReport])).toBe(false);
    const timedPlan = {
      ...plan,
      sessions: plan.sessions.map((session) => ({ ...session, localStartTime: '08:30' })),
    };
    expect(preservesSessionCompletions(timedPlan, [timedReport])).toBe(true);
  });

  it('allows non-schedule corrections without mutating plans, reports or inventing completion for others', () => {
    const original = draft();
    const reports = [report()];
    const changed: PlanDraft = {
      ...original,
      title: 'Corrected title',
      sessions: original.sessions.map((session) => ({
        ...session,
        title: 'Corrected session',
        distanceMeters: null,
        durationSeconds: 0,
        targetRpe: 0,
        notes: 'Explicit correction',
        priority: 'high',
        locks: { date: true, time: true, intensity: true },
      })),
    };
    const beforePlan = structuredClone(changed);
    const beforeReports = structuredClone(reports);
    expect(preservesSessionCompletions(changed, reports)).toBe(true);
    expect(changed).toStrictEqual(beforePlan);
    expect(reports).toStrictEqual(beforeReports);
    expect(original.sessions[0]?.distanceMeters).toBe(0);
    expect(original.sessions[0]?.durationSeconds).toBeNull();
  });
});
