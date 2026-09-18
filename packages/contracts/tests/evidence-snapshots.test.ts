import { describe, it, expect } from 'vitest';
import {
  coreEvidenceBodySchema,
  coreEvidenceCaptureSchema,
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListSchema,
  coreEvidenceSnapshotListQuerySchema,
  type CoreEvidenceBody,
} from '../src/evidence-snapshots.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  at = '2026-09-18T00:00:00Z';
function first<T>(items: T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
function fixture(): CoreEvidenceBody {
  const values = {
    title: null,
    kind: 'running' as const,
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown' as const,
    distanceMeters: 0,
    timezone: null,
  };
  return {
    schemaVersion: 1,
    scope: 'running-core-v1',
    window: { from: '2026-09-17', toExclusive: '2026-09-19', timezone: 'UTC' },
    thread: {
      id,
      planVersionId: id,
      title: 'thread',
      scope: { kind: 'block', targetId: 'block' },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    plan: {
      id,
      version: 1,
      createdAt: at,
      draft: {
        title: 'plan',
        timezone: 'UTC',
        periods: [
          ...(['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
            id: level,
            parentId: index === 0 ? null : (levels[index - 1] ?? null),
            level,
            title: level,
            startDate: '2026-09-17',
            endDateExclusive: '2026-09-19',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          })),
          {
            id: 'block',
            parentId: 'phase',
            level: 'block',
            title: 'block',
            startDate: '2026-09-17',
            endDateExclusive: '2026-09-19',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    },
    messages: [{ id, threadId: id, revision: 1, role: 'user', content: 'question', createdAt: at }],
    dependencies: {
      schemaVersion: 1,
      scope: 'core-ledgers-v1',
      athleteId: 'owner',
      capturedAt: at,
      trainingPlan: { kind: 'exists', versionId: other },
      activities: { count: '1', revisionSum: '1' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      aiConsent: { kind: 'absent' },
    },
    activities: [
      {
        localDate: null,
        record: {
          id,
          revision: 1,
          source: { kind: 'fixture', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) },
          original: values,
          effective: values,
          overlay: {},
        },
      },
    ],
    checkIns: [],
    sessionCompletions: [],
  };
}
describe('structured core evidence snapshot', () => {
  it('preserves null/zero and historical pinned plan distinct from current head', () => {
    const b = fixture();
    expect(coreEvidenceBodySchema.parse(b)).toEqual(b);
    expect(b.activities[0]?.record.effective.distanceMeters).toBe(0);
  });
  it('validates 1..90 local days and canonical capture key', () => {
    const input = {
      expectedConversationRevision: 1,
      window: fixture().window,
      idempotencyKey: 'key',
    };
    expect(coreEvidenceCaptureSchema.safeParse(input).success).toBe(true);
    for (const patch of [
      { expectedConversationRevision: 0 },
      { idempotencyKey: ' x' },
      { idempotencyKey: 'x\0' },
      { window: { ...input.window, toExclusive: input.window.from } },
      { window: { ...input.window, toExclusive: '2027-01-01' } },
      { window: { ...input.window, timezone: 'invalid' } },
    ])
      expect(coreEvidenceCaptureSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('requires entire conversation with matching identities and ordered revisions', () => {
    for (const mutate of [
      (b: CoreEvidenceBody) => {
        b.messages = [];
      },
      (b: CoreEvidenceBody) => {
        b.thread.revision = 2;
      },
      (b: CoreEvidenceBody) => {
        first(b.messages).threadId = other;
      },
      (b: CoreEvidenceBody) => {
        b.messages.push(first(b.messages));
      },
    ]) {
      const b = fixture();
      mutate(b);
      expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
    }
  });
  it('rejects wrong scope, plan identity and dependencies that cannot cover records', () => {
    for (const mutate of [
      (b: CoreEvidenceBody) => {
        b.plan.id = other;
      },
      (b: CoreEvidenceBody) => {
        b.thread.scope = { kind: 'phase', targetId: 'block' };
      },
      (b: CoreEvidenceBody) => {
        b.dependencies.activities = { count: '0', revisionSum: '0' };
      },
      (b: CoreEvidenceBody) => {
        b.activities.push(first(b.activities));
      },
    ]) {
      const b = fixture();
      mutate(b);
      expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
    }
  });
  it('checks effective observed date in requested timezone, with end exclusive', () => {
    const b = fixture();
    const record = first(b.activities);
    record.record.effective.startedAt = '2026-09-18T23:30:00Z';
    b.window.timezone = 'Asia/Seoul';
    record.localDate = '2026-09-19';
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
    b.window.toExclusive = '2026-09-20';
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(true);
    record.localDate = null;
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
  });
  it('keeps original check-in local date separate and covers its collection revision', () => {
    const b = fixture();
    b.checkIns = [
      {
        localDate: '2026-09-18',
        record: {
          id,
          revision: 1,
          values: {
            observedAt: at,
            timezone: 'America/Los_Angeles',
            fatigue: 0,
            discomfort: null,
            bodyLocation: null,
            note: null,
          },
          localDate: '2026-09-17',
          recordedAt: at,
          updatedAt: at,
          source: 'user',
          method: 'self_report',
          definitionVersion: 'checkin-v1',
        },
      },
    ];
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
    b.dependencies.checkIns = { kind: 'exists', revision: 1 };
    expect(coreEvidenceBodySchema.parse(b).checkIns[0]?.record.localDate).toBe('2026-09-17');
  });
  it('includes historical completion reports only for pinned-plan sessions with a covering head', () => {
    const b = fixture();
    b.plan.draft.sessions.push({
      id: 'run',
      blockId: 'block',
      date: '2026-09-18',
      localStartTime: null,
      title: 'run',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    });
    b.sessionCompletions.push({
      sessionId: 'run',
      revision: 1,
      planVersionId: other,
      schedule: { blockId: 'block', date: '2026-09-18', localStartTime: null, timezone: 'UTC' },
      status: 'completed',
      reportedAt: at,
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    });
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
    b.dependencies.sessionCompletions = { kind: 'exists', revision: 1 };
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(true);
    b.plan.draft.sessions = [];
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
  });
  it('rejects malformed refinements without throwing and limits complete conversations', () => {
    const b = fixture();
    expect(
      coreEvidenceBodySchema.safeParse({ ...b, window: { ...b.window, timezone: 'invalid' } })
        .success,
    ).toBe(false);
    first(b.activities).record.revision = 1.5;
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
    const full = fixture();
    full.messages = Array.from({ length: 101 }, (_, i) => ({
      ...first(full.messages),
      revision: i + 1,
    }));
    full.thread.revision = 101;
    expect(coreEvidenceBodySchema.safeParse(full).success).toBe(false);
  });
  it('requires metadata identity and capture time, and purged snapshots contain no body', () => {
    const s = { id, threadId: id, createdAt: at, status: 'available', body: fixture() };
    expect(coreEvidenceSnapshotSchema.safeParse(s).success).toBe(true);
    expect(coreEvidenceSnapshotSchema.safeParse({ ...s, threadId: other }).success).toBe(false);
    expect(
      coreEvidenceSnapshotSchema.safeParse({ ...s, createdAt: '2026-09-19T00:00:00Z' }).success,
    ).toBe(false);
    const purged = { id, threadId: id, createdAt: at, status: 'purged', reason: 'source_deleted' };
    expect(coreEvidenceSnapshotSchema.safeParse(purged).success).toBe(true);
    expect(coreEvidenceSnapshotSchema.safeParse({ ...purged, body: fixture() }).success).toBe(
      false,
    );
  });
  it('bounds metadata pages and rejects unsupported body authority', () => {
    expect(coreEvidenceSnapshotListQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(coreEvidenceSnapshotListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      coreEvidenceSnapshotListSchema.safeParse({
        items: [{ id, threadId: id, createdAt: at, status: 'available', body: fixture() }],
        total: 1,
      }).success,
    ).toBe(false);
    expect(coreEvidenceBodySchema.safeParse({ ...fixture(), policyVersion: 'fake' }).success).toBe(
      false,
    );
    expect(coreEvidenceBodySchema.safeParse({ ...fixture(), schemaVersion: 2 }).success).toBe(
      false,
    );
    const b = fixture();
    b.activities = Array.from({ length: 501 }, () => first(b.activities));
    expect(coreEvidenceBodySchema.safeParse(b).success).toBe(false);
  });
});

describe('v2 pinned mandatory user constraints', () => {
  function v2() {
    const old = fixture();
    return {
      ...old,
      schemaVersion: 2,
      scope: 'running-core-v2',
      dependencies: {
        ...old.dependencies,
        schemaVersion: 2,
        scope: 'core-ledgers-v2',
        userConstraints: { kind: 'absent' },
      },
      userConstraints: { headRevision: null, items: [] },
    };
  }
  it('retains historical v1 exactly and requires v2 constraints even when unrecorded', () => {
    const old = fixture();
    expect(coreEvidenceBodySchema.parse(old)).toEqual(old);
    const current = v2();
    expect(coreEvidenceBodySchema.parse(current)).toEqual(current);
    const { userConstraints: removed, ...missing } = current;
    expect(removed.headRevision).toBeNull();
    expect(coreEvidenceBodySchema.safeParse(missing).success).toBe(false);
    expect(
      coreEvidenceBodySchema.safeParse({ ...old, userConstraints: current.userConstraints })
        .success,
    ).toBe(false);
  });
  it('distinguishes unrecorded vs explicitly cleared heads and rejects mismatches', () => {
    const current = v2();
    const cleared = {
      ...current,
      userConstraints: { headRevision: 2, items: [] },
      dependencies: { ...current.dependencies, userConstraints: { kind: 'exists', revision: 2 } },
    };
    expect(coreEvidenceBodySchema.safeParse(cleared).success).toBe(true);
    expect(
      coreEvidenceBodySchema.safeParse({
        ...cleared,
        userConstraints: { headRevision: null, items: [] },
      }).success,
    ).toBe(false);
    expect(
      coreEvidenceBodySchema.safeParse({
        ...cleared,
        userConstraints: { headRevision: 3, items: [] },
      }).success,
    ).toBe(false);
  });
  it('covers all active record revisions and forbids duplicates/more than50', () => {
    const current = v2();
    const entry = { id, revision: 2, text: '확인한 문장', confirmedAt: at, updatedAt: at };
    const body = {
      ...current,
      userConstraints: { headRevision: 3, items: [entry, { ...entry, id: other, revision: 1 }] },
      dependencies: { ...current.dependencies, userConstraints: { kind: 'exists', revision: 3 } },
    };
    expect(coreEvidenceBodySchema.safeParse(body).success).toBe(true);
    expect(
      coreEvidenceBodySchema.safeParse({
        ...body,
        userConstraints: { headRevision: 3, items: [entry, { ...entry, id: other }] },
      }).success,
    ).toBe(false);
    expect(
      coreEvidenceBodySchema.safeParse({
        ...body,
        userConstraints: { headRevision: 3, items: [entry, entry] },
      }).success,
    ).toBe(false);
    expect(
      coreEvidenceBodySchema.safeParse({
        ...body,
        userConstraints: { headRevision: 3, items: Array.from({ length: 51 }, () => entry) },
      }).success,
    ).toBe(false);
  });
  it('rejects mixed manifest versions and preserves common body integrity checks in v2', () => {
    const current = v2(),
      old = fixture();
    expect(
      coreEvidenceBodySchema.safeParse({ ...current, dependencies: old.dependencies }).success,
    ).toBe(false);
    expect(
      coreEvidenceBodySchema.safeParse({ ...old, dependencies: current.dependencies }).success,
    ).toBe(false);
    expect(coreEvidenceBodySchema.safeParse({ ...current, messages: [] }).success).toBe(false);
    expect(
      coreEvidenceSnapshotSchema.safeParse({
        id,
        threadId: other,
        createdAt: at,
        status: 'available',
        body: current,
      }).success,
    ).toBe(false);
  });
});
