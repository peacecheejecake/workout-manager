import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecoveryRepository } from '@workout/server-persistence/recovery-core';
import { ProductRequestError } from '../src/product-boundary.js';
import { registerRecoveryRoutes } from '../src/recovery-routes.js';

const method = {
  schemaVersion: 1 as const,
  methodId: '30000000-0000-4000-8000-000000000001',
  versionId: '30000000-0000-4000-8000-000000000002',
  version: 1,
  title: 'Personal rest note',
  category: 'rest' as const,
  intendedUse: '',
  applicability: [],
  cautions: [],
  sourceDescription: 'User',
  evidenceLimitations: 'Unreviewed',
  reviewState: 'unreviewed' as const,
  reviewedAt: null,
  source: 'user_recorded' as const,
  createdAt: '2026-09-18T10:00:00.000Z',
};
const apps: ReturnType<typeof Fastify>[] = [];
function setup() {
  const repository: RecoveryRepository = {
    workspace: vi.fn().mockResolvedValue({
      methods: [],
      strategies: [],
      actions: [],
      observations: [],
      planRefs: [],
      reassessment: [],
    }),
    readStrategy: vi.fn().mockResolvedValue(null),
    createMethod: vi.fn().mockResolvedValue(method),
    createStrategy: vi.fn(),
    confirmStrategy: vi.fn(),
    createAction: vi.fn(),
    correctAction: vi.fn(),
    deleteAction: vi.fn(),
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    return reply.code(500).send({ error: { code: 'UNEXPECTED' } });
  });
  registerRecoveryRoutes(app, repository, () => ({
    athleteId: 'owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, repository };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it('uses authenticated ownership, header idempotency and strict payload validation', async () => {
  const { app, repository } = setup();
  const read = await app.inject({ method: 'GET', url: '/recovery' });
  expect(read.statusCode).toBe(200);
  expect(repository.workspace).toHaveBeenCalledWith('owner');
  const missingStrategy = await app.inject({
    method: 'GET',
    url: '/recovery/strategies/30000000-0000-4000-8000-000000000003',
  });
  expect(missingStrategy.statusCode).toBe(404);
  expect(repository.readStrategy).toHaveBeenCalledWith(
    'owner',
    '30000000-0000-4000-8000-000000000003',
  );
  const body = {
    title: 'Personal rest note',
    category: 'rest',
    intendedUse: '',
    applicability: [],
    cautions: [],
    sourceDescription: 'User',
    evidenceLimitations: 'Unreviewed',
  };
  const forbidden = await app.inject({
    method: 'POST',
    url: '/recovery/methods',
    headers: { 'idempotency-key': 'recovery-route-1' },
    payload: { ...body, athleteId: 'another-account' },
  });
  expect(forbidden.statusCode).toBe(400);
  expect(repository.createMethod).not.toHaveBeenCalled();
  const forgedReview = await app.inject({
    method: 'POST',
    url: '/recovery/methods',
    headers: { 'idempotency-key': 'recovery-route-1' },
    payload: { ...body, reviewState: 'reviewed_for_stated_use' },
  });
  expect(forgedReview.statusCode).toBe(400);
  const valid = await app.inject({
    method: 'POST',
    url: '/recovery/methods',
    headers: { 'idempotency-key': 'recovery-route-1' },
    payload: body,
  });
  expect(valid.statusCode).toBe(200);
  expect(repository.createMethod).toHaveBeenCalledWith('owner', {
    ...body,
    idempotencyKey: 'recovery-route-1',
  });
  const bodyKey = await app.inject({
    method: 'POST',
    url: '/recovery/methods',
    headers: { 'idempotency-key': 'recovery-route-2' },
    payload: { ...body, idempotencyKey: 'body-forged' },
  });
  expect(bodyKey.statusCode).toBe(400);
  expect(repository.createMethod).toHaveBeenCalledTimes(1);
});
