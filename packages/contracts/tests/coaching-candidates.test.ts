import { describe, expect, it } from 'vitest';
import {
  trainingCandidateDiffV1Schema,
  trainingCandidateDraftV1Schema,
  trainingCandidateV1Schema,
  trainingDecisionV1Schema,
  trainingProposalV1Schema,
  trainingCandidateValidationV1Schema,
  trainingCandidatePartialRequestV1Schema,
  trainingCandidateStatusV1Schema,
} from '../src/coaching-candidates.js';

const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const decisionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const proposalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const candidateId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const at = '2026-09-18T00:00:00Z';
const strategy = {
  summary: 'Synthetic alternative',
  preservedIntent: 'Keep the original purpose',
  rationale: 'Synthetic fixture only',
  unconfirmedInformation: ['Current context unknown'],
  revisitWhen: 'Before the planned session',
};
const basis = {
  schemaVersion: 1,
  scope: 'running-core-v2-training',
  athleteId: 'synthetic-owner',
  evidenceSnapshotId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  threadId: '11111111-1111-4111-8111-111111111111',
  conversationRevision: 1,
  planVersionId: planId,
  dependencies: {
    schemaVersion: 2,
    scope: 'core-ledgers-v2',
    athleteId: 'synthetic-owner',
    capturedAt: at,
    trainingPlan: { kind: 'exists', versionId: planId },
    activities: { count: '0', revisionSum: '0' },
    checkIns: { kind: 'absent' },
    sessionCompletions: { kind: 'absent' },
    userConstraints: { kind: 'absent' },
    aiConsent: { kind: 'exists', revision: 1, granted: true },
  },
  policy: { id: 'synthetic-policy', version: '1' },
  retrieval: { kind: 'none' },
};
const plan = {
  title: 'Synthetic plan',
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : levels[index - 1],
    level,
    title: level,
    startDate: '2026-09-18',
    endDateExclusive: '2026-09-20',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [],
};
const metric = (unit: 's' | 'm') => ({
  before: { unit, knownMin: 0, knownMax: 0, unknownSessionIds: [] },
  after: { unit, knownMin: 0, knownMax: 0, unknownSessionIds: [] },
  delta: { unit, min: 0, max: 0 },
});
const draft = {
  schemaVersion: 1,
  scope: 'running-core-v2-training',
  basis,
  before: { id: planId, version: 1, createdAt: at, draft: plan },
  proposed: plan,
  asOfLocalDate: '2026-09-18',
  strategy,
  diff: {
    definitionVersion: 'training-candidate-diff-v1',
    title: null,
    periodChanges: [],
    sessionChanges: [],
    duration: metric('s'),
    distance: metric('m'),
  },
  validation: {
    definitionVersion: 'training-candidate-validation-v1',
    status: 'invalid',
    errors: [{ code: 'NO_CHANGE', subject: { kind: 'plan' } }],
    warnings: [],
    unknowns: [],
  },
};

describe('M1-05j1 versioned candidate contracts', () => {
  it('keeps partial selection bounded, unique and separate from a proposed plan', () => {
    const request = {
      schemaVersion: 1,
      sessionIds: ['session'],
      periodIds: [],
      includeTitle: false,
      idempotencyKey: 'partial-1',
    };
    expect(trainingCandidatePartialRequestV1Schema.parse(request)).toEqual(request);
    for (const invalid of [
      { ...request, schemaVersion: 2 },
      { ...request, sessionIds: [], includeTitle: false },
      { ...request, sessionIds: ['session', 'session'] },
      { ...request, periodIds: ['block', 'block'] },
      { ...request, sessionIds: [' bad '] },
      { ...request, periodIds: ['x'.repeat(201)] },
      { ...request, sessionIds: Array.from({ length: 1001 }, (_, index) => `s${index}`) },
      { ...request, periodIds: Array.from({ length: 101 }, (_, index) => `p${index}`) },
      { ...request, idempotencyKey: '' },
      { ...request, idempotencyKey: ' bad ' },
      { ...request, proposed: draft.proposed },
      { ...request, candidateId },
    ])
      expect(trainingCandidatePartialRequestV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('supports optional lineage on new candidates and metadata-only status', () => {
    const sealed = {
      ...draft,
      id: candidateId,
      proposalId,
      decisionId,
      runId,
      createdAt: at,
      digest: 'a'.repeat(64),
    };
    expect(trainingCandidateV1Schema.safeParse(sealed).success).toBe(true);
    expect(
      trainingCandidateV1Schema.safeParse({ ...sealed, parentCandidateId: runId }).success,
    ).toBe(true);
    expect(
      trainingCandidateV1Schema.safeParse({ ...sealed, parentCandidateId: 'wrong' }).success,
    ).toBe(false);
    for (const kind of ['current', 'stale', 'withdrawn'] as const)
      expect(
        trainingCandidateStatusV1Schema.parse({ schemaVersion: 1, candidateId, kind }),
      ).toEqual({ schemaVersion: 1, candidateId, kind });
    expect(
      trainingCandidateStatusV1Schema.safeParse({
        schemaVersion: 1,
        candidateId,
        kind: 'stale',
        candidate: sealed,
      }).success,
    ).toBe(false);
  });

  it('keeps pure drafts unsealed and requires a server digest on public candidates', () => {
    expect(trainingCandidateDraftV1Schema.safeParse(draft).success).toBe(true);
    expect(trainingCandidateV1Schema.safeParse(draft).success).toBe(false);
    const sealed = {
      ...draft,
      id: candidateId,
      proposalId,
      decisionId,
      runId,
      createdAt: at,
      digest: 'a'.repeat(64),
    };
    expect(trainingCandidateV1Schema.safeParse(sealed).success).toBe(true);
    expect(trainingCandidateV1Schema.safeParse({ ...sealed, digest: 'not-a-digest' }).success).toBe(
      false,
    );
    expect(
      trainingCandidateV1Schema.safeParse({ ...sealed, before: { ...draft.before, id: runId } })
        .success,
    ).toBe(false);
  });

  it('links decision, proposal and candidate identities without treating run output as a decision', () => {
    expect(
      trainingDecisionV1Schema.safeParse({
        schemaVersion: 1,
        scope: 'running-core-v2-training',
        id: decisionId,
        runId,
        basis,
        strategy,
        createdAt: at,
      }).success,
    ).toBe(true);
    expect(
      trainingProposalV1Schema.safeParse({
        schemaVersion: 1,
        scope: 'running-core-v2-training',
        id: proposalId,
        runId,
        decisionId,
        candidateIds: [candidateId],
        createdAt: at,
      }).success,
    ).toBe(true);
    expect(
      trainingProposalV1Schema.safeParse({
        schemaVersion: 1,
        scope: 'running-core-v2-training',
        id: proposalId,
        runId,
        decisionId,
        candidateIds: [candidateId, candidateId],
        createdAt: at,
      }).success,
    ).toBe(false);
  });

  it('rejects invented aggregate deltas for unknown targets and inconsistent validation states', () => {
    expect(
      trainingCandidateDiffV1Schema.safeParse({
        ...draft.diff,
        duration: {
          before: { unit: 's', knownMin: 0, knownMax: 0, unknownSessionIds: ['missing'] },
          after: { unit: 's', knownMin: 0, knownMax: 0, unknownSessionIds: [] },
          delta: { unit: 's', min: 0, max: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      trainingCandidateValidationV1Schema.safeParse({
        ...draft.validation,
        status: 'checked',
      }).success,
    ).toBe(false);
  });
});
