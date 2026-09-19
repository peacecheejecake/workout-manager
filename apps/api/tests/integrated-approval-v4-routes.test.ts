import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntegratedApprovalV4Error } from '@workout/server-persistence/integrated-approval-v4';
import { registerIntegratedApprovalV4Routes } from '../src/integrated-approval-v4-routes.js';

const candidateId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const aggregateId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const approvalId = '55555555-5555-4555-8555-555555555555';
const at = '2026-09-19T00:00:00.000Z';
const apps: ReturnType<typeof Fastify>[] = [];

const basis = {
  schemaVersion: 4 as const,
  planHeads: [{ domain: 'training' as const, aggregateId, head: { kind: 'absent' as const } }],
  contextDependencies: [],
  preferenceRevision: 0,
  constraintRevision: 0,
  conversationRevision: 0,
  policyVersion: 'integrated-v4',
  evidenceSnapshotId: 'evidence',
};
const candidate = {
  schemaVersion: 4 as const,
  id: candidateId,
  proposalId,
  digest: 'a'.repeat(64),
  basis,
  writes: [
    {
      domain: 'training' as const,
      aggregateId,
      proposed: {
        timezone: 'UTC',
        title: 'Integrated proposal',
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season' as const,
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
  summary: 'Training update',
  validation: { status: 'checked' as const, errors: [], unknowns: [] },
  createdAt: at,
};
const result = {
  schemaVersion: 4 as const,
  approvalId,
  candidateId,
  versions: [{ domain: 'training' as const, aggregateId, versionId }],
  occurrenceIds: [],
  approvedAt: at,
};
const approval = {
  schemaVersion: 4 as const,
  confirmed: true as const,
  proposalId,
  candidateId,
  proposalDigest: candidate.digest,
  writeDomains: ['training' as const],
  expectedBasis: basis,
};
const validV3Approval = {
  schemaVersion: 3 as const,
  confirmed: true as const,
  proposalId,
  candidateId,
  proposalDigest: candidate.digest,
  expectedBasis: {
    schemaVersion: 3 as const,
    domains: {
      scope: 'training' as const,
      training: {
        planVersionId: versionId,
        activityDataRevision: 0,
        exerciseCatalogRevision: 0,
      },
      nutrition: null,
    },
    contextDependencies: [],
    preferenceRevision: 0,
    constraintRevision: 0,
    conversationRevision: 0,
    policyVersion: 'joint-v3',
    evidenceSnapshotId: 'evidence',
  },
};

function setup() {
  const app = Fastify();
  const repository = {
    captureBasis: vi.fn(),
    prepareInternal: vi.fn(),
    read: vi.fn().mockResolvedValue(candidate),
    approve: vi.fn().mockResolvedValue(result),
  };
  registerIntegratedApprovalV4Routes(app, repository, () => ({
    athleteId: 'owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, repository };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('integrated approval v4 routes', () => {
  it('treats omitted and legacy maximum versions as unsupported without reading the candidate', async () => {
    const { app, repository } = setup();
    for (const suffix of ['', '?maxSchemaVersion=3']) {
      const response = await app.inject({
        url: `/integrated-candidates/${candidateId}${suffix}`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('UNSUPPORTED_SCHEMA_VERSION');
    }
    expect(repository.read).not.toHaveBeenCalled();
  });

  it('returns a v4 candidate only after explicit negotiation and derives tenant identity', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      url: `/integrated-candidates/${candidateId}?maxSchemaVersion=4`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(candidate);
    expect(repository.read).toHaveBeenCalledWith('owner', candidateId);
  });

  it('combines explicit confirmation with the idempotency header before approval', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/integrated-candidates/${candidateId}/approve`,
      headers: { 'idempotency-key': 'integrated-key-1' },
      payload: approval,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(repository.approve).toHaveBeenCalledWith('owner', {
      ...approval,
      idempotencyKey: 'integrated-key-1',
    });
  });

  it('separates unsupported versions, malformed v4 payloads, and path mismatches', async () => {
    const { app, repository } = setup();
    const cases = [
      [{ ...approval, schemaVersion: 5 }, 409, 'UNSUPPORTED_SCHEMA_VERSION'],
      [validV3Approval, 409, 'UNSUPPORTED_SCHEMA_VERSION'],
      [{ ...approval, schemaVersion: 3 }, 400, 'INVALID_APPROVAL_PAYLOAD'],
      [{ ...approval, confirmed: false }, 400, 'INVALID_APPROVAL_PAYLOAD'],
      [
        { ...approval, expectedBasis: { ...basis, schemaVersion: 3 } },
        400,
        'INVALID_APPROVAL_PAYLOAD',
      ],
      [
        { ...approval, idempotencyKey: 'body-key-is-not-authoritative' },
        400,
        'INVALID_APPROVAL_PAYLOAD',
      ],
      [{ ...approval, candidateId: aggregateId }, 400, 'CANDIDATE_ID_MISMATCH'],
    ] as const;
    for (const [payload, status, code] of cases) {
      const response = await app.inject({
        method: 'POST',
        url: `/integrated-candidates/${candidateId}/approve`,
        headers: { 'idempotency-key': 'integrated-key-1' },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().message).toBe(code);
    }
    expect(repository.approve).not.toHaveBeenCalled();
  });

  it.each([
    ['AI_CONSENT_REQUIRED', 403],
    ['CANDIDATE_UNAVAILABLE', 404],
    ['CANDIDATE_MISMATCH', 409],
    ['STALE_BASIS', 409],
    ['CANDIDATE_NOT_APPROVABLE', 422],
  ] as const)('maps %s to a stable HTTP status', async (code, status) => {
    const { app, repository } = setup();
    repository.approve.mockRejectedValueOnce(new IntegratedApprovalV4Error(code));
    const response = await app.inject({
      method: 'POST',
      url: `/integrated-candidates/${candidateId}/approve`,
      headers: { 'idempotency-key': 'integrated-key-1' },
      payload: approval,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().message).toBe(code);
  });
});
