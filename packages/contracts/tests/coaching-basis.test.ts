import { describe, expect, it } from 'vitest';
import {
  buildTrainingCoachingBasis,
  compareTrainingCoachingBasis,
  trainingCoachingBasisV1Schema,
  type TrainingCoachingBasisObservationV1,
  type TrainingCoachingBasisV1,
} from '../src/coaching-basis.js';
import { coreEvidenceSnapshotSchema } from '../src/evidence-snapshots.js';

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshotId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const at = '2026-09-18T00:00:00Z';
const owner = 'synthetic-owner';
const policy = { id: 'running-core-policy', version: '2026-09-18' };

function snapshot() {
  const period = (level: 'season' | 'wave' | 'phase' | 'block', parentId: string | null) => ({
    id: level,
    parentId,
    level,
    title: level,
    startDate: '2026-09-17',
    endDateExclusive: '2026-09-19',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  });
  return coreEvidenceSnapshotSchema.parse({
    id: snapshotId,
    threadId,
    createdAt: at,
    status: 'available',
    body: {
      schemaVersion: 2,
      scope: 'running-core-v2',
      userConstraints: { headRevision: null, items: [] },
      window: { from: '2026-09-17', toExclusive: '2026-09-19', timezone: 'UTC' },
      thread: {
        id: threadId,
        planVersionId: planId,
        title: 'Review',
        scope: { kind: 'block', targetId: 'block' },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
      plan: {
        id: planId,
        version: 1,
        createdAt: at,
        draft: {
          timezone: 'UTC',
          title: 'Plan',
          periods: [
            period('season', null),
            period('wave', 'season'),
            period('phase', 'wave'),
            period('block', 'phase'),
          ],
          sessions: [],
        },
      },
      messages: [
        { id: otherId, threadId, revision: 1, role: 'user', content: 'Review', createdAt: at },
      ],
      dependencies: {
        schemaVersion: 2,
        scope: 'core-ledgers-v2',
        athleteId: owner,
        capturedAt: at,
        trainingPlan: { kind: 'exists', versionId: planId },
        activities: { count: '0', revisionSum: '0' },
        checkIns: { kind: 'absent' },
        sessionCompletions: { kind: 'absent' },
        userConstraints: { kind: 'absent' },
        aiConsent: { kind: 'exists', revision: 1, granted: true },
      },
      activities: [],
      checkIns: [],
      sessionCompletions: [],
    },
  });
}

function basis(): TrainingCoachingBasisV1 {
  const result = buildTrainingCoachingBasis({ athleteId: owner, snapshot: snapshot(), policy });
  if (!result.ok) throw new Error(`Fixture basis rejected: ${result.reason}`);
  return result.basis;
}

function observation(expected = basis()): TrainingCoachingBasisObservationV1 {
  return {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: owner,
    evidence: {
      id: expected.evidenceSnapshotId,
      threadId: expected.threadId,
      createdAt: expected.dependencies.capturedAt,
      status: 'available',
    },
    conversationRevision: expected.conversationRevision,
    dependencies: expected.dependencies,
    policy: expected.policy,
    retrieval: { kind: 'none' },
  };
}

describe('training-only running-core coaching basis', () => {
  it('derives only the supported pinned v2 snapshot and records explicit no retrieval', () => {
    const value = basis();
    expect(value).toMatchObject({
      schemaVersion: 1,
      scope: 'running-core-v2-training',
      athleteId: owner,
      evidenceSnapshotId: snapshotId,
      threadId,
      conversationRevision: 1,
      planVersionId: planId,
      policy,
      retrieval: { kind: 'none' },
    });
    expect(trainingCoachingBasisV1Schema.parse(value)).toEqual(value);
    expect(compareTrainingCoachingBasis(value, observation(value))).toEqual({
      status: 'fresh',
      changed: [],
    });
  });

  it('rejects purged, historical v1, foreign, outdated-head and nonconsented evidence', () => {
    const current = snapshot();
    if (current.status !== 'available' || current.body.schemaVersion !== 2)
      throw new Error('Invalid fixture');
    const { userConstraints: _constraints, ...oldBody } = current.body;
    const { userConstraints: _constraintHead, ...oldDependencies } = oldBody.dependencies;
    expect(_constraints.items).toEqual([]);
    expect(_constraintHead).toEqual({ kind: 'absent' });
    const cases: { snapshot: unknown; athleteId?: string; reason: string }[] = [
      {
        snapshot: {
          id: snapshotId,
          threadId,
          createdAt: at,
          status: 'purged',
          reason: 'source_deleted',
        },
        reason: 'EVIDENCE_UNAVAILABLE',
      },
      {
        snapshot: {
          ...current,
          body: {
            ...oldBody,
            schemaVersion: 1,
            scope: 'running-core-v1',
            dependencies: {
              ...oldDependencies,
              schemaVersion: 1,
              scope: 'core-ledgers-v1',
            },
          },
        },
        reason: 'UNSUPPORTED_EVIDENCE_VERSION',
      },
      { snapshot: current, athleteId: 'different-owner', reason: 'OWNER_MISMATCH' },
      {
        snapshot: {
          ...current,
          body: {
            ...current.body,
            dependencies: {
              ...current.body.dependencies,
              trainingPlan: { kind: 'exists', versionId: otherId },
            },
          },
        },
        reason: 'PINNED_PLAN_NOT_CURRENT',
      },
      ...([{ kind: 'absent' }, { kind: 'exists', revision: 2, granted: false }] as const).map(
        (aiConsent) => ({
          snapshot: {
            ...current,
            body: {
              ...current.body,
              dependencies: { ...current.body.dependencies, aiConsent },
            },
          },
          reason: 'AI_CONSENT_REQUIRED',
        }),
      ),
    ];
    for (const value of cases)
      expect(
        buildTrainingCoachingBasis({
          athleteId: value.athleteId ?? owner,
          snapshot: value.snapshot,
          policy,
        }),
      ).toEqual({ ok: false, reason: value.reason });
  });

  it('rejects unknown fields and invalid pinned snapshot identities', () => {
    const current = snapshot();
    if (current.status !== 'available') throw new Error('Invalid fixture');
    for (const input of [
      { athleteId: owner, snapshot: current, policy, extra: true },
      { athleteId: owner, snapshot: { ...current, extra: true }, policy },
      { athleteId: owner, snapshot: current, policy: { ...policy, extra: true } },
      {
        athleteId: owner,
        snapshot: { ...current, id: snapshotId.toUpperCase() },
        policy,
      },
      {
        athleteId: owner,
        snapshot: { ...current, body: { ...current.body, extra: true } },
        policy,
      },
      {
        athleteId: owner,
        snapshot: {
          ...current,
          body: { ...current.body, plan: { ...current.body.plan, id: otherId } },
        },
        policy,
      },
    ])
      expect(buildTrainingCoachingBasis(input)).toEqual({ ok: false, reason: 'INVALID_INPUT' });
  });

  it.each([
    [
      'conversation',
      (v: TrainingCoachingBasisObservationV1) => ({ ...v, conversationRevision: 2 }),
    ],
    [
      'policy',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        policy: { ...v.policy, version: 'next' },
      }),
    ],
    [
      'evidence',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        evidence: { ...v.evidence, status: 'purged', reason: 'source_deleted' },
      }),
    ],
    [
      'dependencies.trainingPlan',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        dependencies: { ...v.dependencies, trainingPlan: { kind: 'absent' } },
      }),
    ],
    [
      'dependencies.activities',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        dependencies: { ...v.dependencies, activities: { count: '1', revisionSum: '1' } },
      }),
    ],
    [
      'dependencies.checkIns',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        dependencies: { ...v.dependencies, checkIns: { kind: 'exists', revision: 1 } },
      }),
    ],
    [
      'dependencies.sessionCompletions',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        dependencies: { ...v.dependencies, sessionCompletions: { kind: 'exists', revision: 1 } },
      }),
    ],
    [
      'dependencies.userConstraints',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        dependencies: { ...v.dependencies, userConstraints: { kind: 'exists', revision: 1 } },
      }),
    ],
    [
      'dependencies.aiConsent',
      (v: TrainingCoachingBasisObservationV1) => ({
        ...v,
        dependencies: {
          ...v.dependencies,
          aiConsent: { kind: 'exists', revision: 2, granted: false },
        },
      }),
    ],
  ] as const)('marks %s stale', (field, change) => {
    const expected = basis();
    expect(compareTrainingCoachingBasis(expected, change(observation(expected)))).toEqual({
      status: 'stale',
      changed: [field],
    });
  });

  it('keeps absent heads distinct and treats capture timestamps as metadata', () => {
    const expected = basis();
    const current = observation(expected);
    expect(
      compareTrainingCoachingBasis(expected, {
        ...current,
        evidence: { ...current.evidence, createdAt: '2026-09-18T00:00:00.001Z' },
        dependencies: { ...current.dependencies, capturedAt: '2026-09-19T00:00:00Z' },
      }),
    ).toEqual({ status: 'fresh', changed: [] });
    expect(
      compareTrainingCoachingBasis(expected, {
        ...current,
        dependencies: { ...current.dependencies, userConstraints: { kind: 'exists', revision: 1 } },
      }),
    ).toEqual({ status: 'stale', changed: ['dependencies.userConstraints'] });
  });

  it('fails closed on owner, version, evidence identity, and unknown fields', () => {
    const expected = basis();
    const current = observation(expected);
    expect(compareTrainingCoachingBasis(expected, { ...current, athleteId: 'other' })).toEqual({
      status: 'unsupported',
      reason: 'INVALID_OR_UNSUPPORTED_BASIS',
    });
    expect(
      compareTrainingCoachingBasis(expected, {
        ...current,
        athleteId: 'other',
        dependencies: { ...current.dependencies, athleteId: 'other' },
      }),
    ).toEqual({ status: 'unsupported', reason: 'OWNER_MISMATCH' });
    expect(
      compareTrainingCoachingBasis(expected, {
        ...current,
        evidence: { ...current.evidence, id: otherId },
      }),
    ).toEqual({ status: 'unsupported', reason: 'EVIDENCE_IDENTITY_MISMATCH' });
    for (const invalid of [
      { ...current, schemaVersion: 2 },
      { ...current, extra: true },
      { ...current, retrieval: { kind: 'resource' } },
      { ...current, dependencies: { ...current.dependencies, untracked: 1 } },
      { ...current, policy: { ...policy, extra: true } },
    ])
      expect(compareTrainingCoachingBasis(expected, invalid)).toEqual({
        status: 'unsupported',
        reason: 'INVALID_OR_UNSUPPORTED_BASIS',
      });
    expect(compareTrainingCoachingBasis({ ...expected, schemaVersion: 2 }, current)).toEqual({
      status: 'unsupported',
      reason: 'INVALID_OR_UNSUPPORTED_BASIS',
    });
  });
});
