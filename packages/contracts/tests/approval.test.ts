import { describe, expect, it } from 'vitest';
import { approvalRequestSchema, decodeApprovalRequest } from '../src/approval.js';

const commonBasis = {
  contextDependencies: [],
  preferenceRevision: 0,
  constraintRevision: 0,
  conversationRevision: 0,
  policyVersion: 'policy',
  evidenceSnapshotId: 'snapshot',
};
const common = {
  proposalId: 'proposal',
  candidateId: 'candidate',
  proposalDigest: 'digest',
  idempotencyKey: 'request',
};
const v3 = {
  ...common,
  schemaVersion: 3,
  confirmed: true,
  proposalDigest: 'a'.repeat(64),
  expectedBasis: {
    ...commonBasis,
    schemaVersion: 3,
    domains: {
      scope: 'nutrition',
      training: null,
      nutrition: { planVersionId: null, intakeDataRevision: 0, foodCatalogRevision: 0 },
    },
  },
};
const v4 = {
  ...common,
  schemaVersion: 4,
  writeDomains: ['routine_schedule'],
  expectedBasis: {
    ...commonBasis,
    schemaVersion: 4,
    planHeads: [{ domain: 'routine_schedule', aggregateId: 'schedule', head: { kind: 'absent' } }],
  },
};

describe('explicit approval version routing', () => {
  it.each([v3, v4])('preserves the original version and absent head', (request) => {
    expect(decodeApprovalRequest(request)).toEqual({ ok: true, data: request });
    expect(approvalRequestSchema.parse(request)).toEqual(request);
  });
  it.each([null, {}, { schemaVersion: '4' }, { schemaVersion: 2 }, { schemaVersion: 5 }])(
    'rejects unsupported versions without migration',
    (input) => {
      expect(decodeApprovalRequest(input)).toEqual({
        ok: false,
        code: 'UNSUPPORTED_SCHEMA_VERSION',
      });
    },
  );
  it.each([
    { ...v3, schemaVersion: 4 },
    { ...v4, schemaVersion: 3 },
    { ...v4, expectedBasis: v3.expectedBasis },
    { ...v4, idempotencyKey: '' },
    { ...v4, approved: true },
  ])('rejects malformed and mixed-version payloads', (input) => {
    expect(decodeApprovalRequest(input)).toEqual({ ok: false, code: 'INVALID_APPROVAL_PAYLOAD' });
  });
});
