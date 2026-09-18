import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { JointApprovalError } from '@workout/server-persistence/joint-approval';
import { registerProductRoutes } from '../src/product-routes.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const nutritionPlanId = '22222222-2222-4222-8222-222222222222';
const payload = {
  threadId,
  nutritionPlanId,
  expectedConversationRevision: 1,
  window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
};
const apps: ReturnType<typeof Fastify>[] = [];
function setup(withFixture: boolean) {
  const app = Fastify();
  const repository = { create: vi.fn().mockRejectedValue(new JointApprovalError('STALE_BASIS')) };
  registerProductRoutes(app, withFixture ? { jointFixture: repository } : {}, () => ({
    athleteId: 'authenticated-owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, repository };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it('registers the fixture endpoint only when the server supplies its repository', async () => {
  const { app, repository } = setup(false);
  const response = await app.inject({
    method: 'POST',
    url: '/joint-fixture-candidates',
    headers: { 'idempotency-key': 'fixture-key-123' },
    payload,
  });
  expect(response.statusCode).toBe(404);
  expect(repository.create).not.toHaveBeenCalled();
});

it('accepts intent only, uses the authenticated tenant and maps a stale manifest to 409', async () => {
  const { app, repository } = setup(true);
  for (const invalid of [
    { ...payload, training: { title: 'Client supplied proposal' } },
    { ...payload, nutrition: [] },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/joint-fixture-candidates',
      headers: { 'idempotency-key': 'fixture-key-123' },
      payload: invalid,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(repository.create).not.toHaveBeenCalled();
  const response = await app.inject({
    method: 'POST',
    url: '/joint-fixture-candidates',
    headers: { 'idempotency-key': 'fixture-key-123' },
    payload,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().message).toBe('STALE_BASIS');
  expect(repository.create).toHaveBeenCalledWith('authenticated-owner', {
    ...payload,
    idempotencyKey: 'fixture-key-123',
  });
});
