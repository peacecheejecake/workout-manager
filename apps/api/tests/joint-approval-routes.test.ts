import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { JointApprovalError } from '@workout/server-persistence/joint-approval';
import { registerJointApprovalRoutes } from '../src/joint-approval-routes.js';

const candidateId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const decisionId = '33333333-3333-4333-8333-333333333333';
const apps: ReturnType<typeof Fastify>[] = [];
function setup() {
  const app = Fastify();
  const repository = {
    capture: vi.fn(),
    prepareInternal: vi.fn(),
    read: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    derivePartial: vi.fn(),
    approve: vi.fn().mockResolvedValue({ training: null, nutrition: [] }),
  };
  registerJointApprovalRoutes(app, repository, () => ({
    athleteId: 'owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, repository };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const basis = {
  schemaVersion: 3,
  domains: {
    scope: 'combined',
    training: {
      planVersionId: candidateId,
      activityDataRevision: 0,
      exerciseCatalogRevision: 0,
    },
    nutrition: { planVersionId: null, intakeDataRevision: 0, foodCatalogRevision: 0 },
  },
  contextDependencies: [],
  preferenceRevision: 0,
  constraintRevision: 0,
  conversationRevision: 0,
  policyVersion: '1',
  evidenceSnapshotId: candidateId,
};
const approval = {
  schemaVersion: 3,
  confirmed: true,
  proposalId,
  candidateId,
  proposalDigest: 'a'.repeat(64),
  expectedBasis: basis,
};

it('only reads the authenticated tenant and requires explicit approval confirmation', async () => {
  const { app, repository } = setup();
  const list = await app.inject({ url: `/joint-decisions/${decisionId}/candidates` });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual([]);
  expect(repository.list).toHaveBeenCalledWith('owner', decisionId);
  expect((await app.inject({ url: `/joint-candidates/${candidateId}` })).statusCode).toBe(404);
  for (const invalid of [
    { ...approval, confirmed: false },
    { ...approval, candidateId: decisionId },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/joint-candidates/${candidateId}/approve`,
      headers: { 'idempotency-key': 'joint-approval-key' },
      payload: invalid,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(repository.approve).not.toHaveBeenCalled();
  const accepted = await app.inject({
    method: 'POST',
    url: `/joint-candidates/${candidateId}/approve`,
    headers: { 'idempotency-key': 'joint-approval-key' },
    payload: approval,
  });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toEqual({ training: null, nutrition: [] });
  expect(repository.approve).toHaveBeenCalledWith('owner', {
    ...approval,
    idempotencyKey: 'joint-approval-key',
  });
});

it('rejects empty partial selections and maps stale approval to a conflict', async () => {
  const { app, repository } = setup();
  const invalid = await app.inject({
    method: 'POST',
    url: `/joint-candidates/${candidateId}/partials`,
    headers: { 'idempotency-key': 'partial-key-123' },
    payload: {
      selection: {
        includeTrainingTitle: false,
        trainingPeriodIds: [],
        trainingSessionIds: [],
        nutritionPlanIds: [],
      },
    },
  });
  expect(invalid.statusCode).toBe(400);
  expect(repository.derivePartial).not.toHaveBeenCalled();
  repository.approve.mockRejectedValueOnce(new JointApprovalError('STALE_BASIS'));
  const stale = await app.inject({
    method: 'POST',
    url: `/joint-candidates/${candidateId}/approve`,
    headers: { 'idempotency-key': 'joint-approval-key' },
    payload: approval,
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().message).toBe('STALE_BASIS');
});
