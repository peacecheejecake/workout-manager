import { describe, expect, it } from 'vitest';

import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
} from '../src/integrated-coaching.js';

const candidateId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const aggregateId = '33333333-3333-4333-8333-333333333333';
const candidate = {
  schemaVersion: 4,
  id: candidateId,
  proposalId,
  digest: 'a'.repeat(64),
  basis: {
    schemaVersion: 4,
    planHeads: [{ domain: 'training', aggregateId, head: { kind: 'absent' } }],
    contextDependencies: [],
    preferenceRevision: 0,
    constraintRevision: 0,
    conversationRevision: 0,
    policyVersion: 'integrated-v4:1',
    evidenceSnapshotId: 'snapshot',
  },
  writes: [
    {
      domain: 'training',
      aggregateId,
      proposed: {
        title: 'Plan',
        timezone: 'UTC',
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season',
            title: 'Season',
            startDate: '2026-09-19',
            endDateExclusive: '2026-09-20',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    },
  ],
  summary: 'One explicit training change',
  validation: { status: 'checked', errors: [], unknowns: [] },
  createdAt: '2026-09-19T00:00:00.000Z',
};

describe('integrated coaching v4', () => {
  it('binds every server-owned write to an explicit head expectation', () => {
    expect(integratedCandidateV4Schema.parse(candidate)).toEqual(candidate);
    expect(
      integratedCandidateV4Schema.safeParse({
        ...candidate,
        basis: { ...candidate.basis, planHeads: [] },
      }).success,
    ).toBe(false);
    expect(
      integratedCandidateV4Schema.safeParse({
        ...candidate,
        basis: {
          ...candidate.basis,
          planHeads: [
            ...candidate.basis.planHeads,
            {
              domain: 'training',
              aggregateId: '44444444-4444-4444-8444-444444444444',
              head: { kind: 'absent' },
            },
          ],
        },
        writes: [
          ...candidate.writes,
          {
            ...candidate.writes[0],
            aggregateId: '44444444-4444-4444-8444-444444444444',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires a sealed digest and a versioned atomic result', () => {
    expect(
      integratedCandidateV4Schema.safeParse({ ...candidate, digest: 'unsealed' }).success,
    ).toBe(false);
    expect(
      integratedApprovalResultV4Schema.parse({
        schemaVersion: 4,
        approvalId: '44444444-4444-4444-8444-444444444444',
        candidateId,
        versions: [
          {
            domain: 'training',
            aggregateId,
            versionId: '55555555-5555-4555-8555-555555555555',
          },
        ],
        occurrenceIds: [],
        approvedAt: '2026-09-19T00:01:00.000Z',
      }).schemaVersion,
    ).toBe(4);
  });
});
