import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { StretchingRepository } from '@workout/server-persistence/stretching';
import { StretchingReferenceError } from '@workout/server-persistence/stretching';
import { registerStretchingRoutes } from '../src/stretching-routes.js';

const activityId = '11111111-1111-4111-8111-111111111111';
const exerciseVersionId = '22222222-2222-4222-8222-222222222222';
const logId = '33333333-3333-4333-8333-333333333333';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const createLog = vi
    .fn<StretchingRepository['createLog']>()
    .mockImplementation(async (_athlete, input) => ({
      status: 'active',
      current: {
        ...input.values,
        schemaVersion: 1,
        logId: input.logId,
        revisionId: '44444444-4444-4444-8444-444444444444',
        revision: 1,
        source: 'user',
        confirmation: input.confirmation,
        recordedAt: '2026-09-18T00:01:00.000Z',
      },
    }));
  const listTargets = vi.fn<StretchingRepository['listTargets']>().mockResolvedValue({
    items: [],
    hasMore: false,
  });
  const repository: StretchingRepository = {
    listExercises: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    readExercise: vi.fn().mockResolvedValue(null),
    saveExercise: vi.fn(),
    listTargets,
    listLogs: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    readLog: vi.fn().mockResolvedValue(null),
    createLog,
    correctLog: vi.fn(),
    deleteLog: vi.fn(),
  };
  const app = Fastify();
  registerStretchingRoutes(app, repository, () => ({
    athleteId: 'athlete-1',
    sessionId: 'session-1',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, createLog, listTargets };
}

const values = {
  activityId,
  exerciseVersionId,
  plannedTarget: null,
  allocation: { kind: 'activity_block', startedAt: null, endedAtExclusive: null },
  side: 'left',
  state: 'performed',
  holdSeconds: 20,
  repetitions: null,
  restSeconds: null,
  comfort: 'unknown',
  discomfortNote: null,
  reason: null,
  occurredAt: '2026-09-18T00:00:00.000Z',
};

it('derives tenant ownership and idempotency from the boundary', async () => {
  const { app, createLog } = setup();
  const response = await app.inject({
    method: 'POST',
    url: '/stretching/logs',
    headers: { 'idempotency-key': 'stretch-log-1' },
    payload: {
      schemaVersion: 1,
      logId,
      confirmation: 'user_confirmed',
      values,
    },
  });
  expect(response.statusCode).toBe(200);
  expect(createLog).toHaveBeenCalledWith(
    'athlete-1',
    expect.objectContaining({ idempotencyKey: 'stretch-log-1', values }),
  );
});

it('rejects injected identity and unsupported actual fields before persistence', async () => {
  const { app, createLog } = setup();
  const injectedIdentity = await app.inject({
    method: 'POST',
    url: '/stretching/logs',
    headers: { 'idempotency-key': 'stretch-log-1' },
    payload: {
      schemaVersion: 1,
      logId,
      idempotencyKey: 'attacker-key',
      confirmation: 'user_confirmed',
      values,
    },
  });
  const inventedProviderDetail = await app.inject({
    method: 'POST',
    url: '/stretching/logs',
    headers: { 'idempotency-key': 'stretch-log-2' },
    payload: {
      schemaVersion: 1,
      logId,
      confirmation: 'user_confirmed',
      values: { ...values, athleteId: 'another-user', providerHoldSeconds: 20 },
    },
  });
  expect(injectedIdentity.statusCode).toBe(400);
  expect(inventedProviderDetail.statusCode).toBe(400);
  expect(createLog).not.toHaveBeenCalled();
});

it('maps unavailable Activities to 404 without leaking repository details', async () => {
  const { app, listTargets } = setup();
  listTargets.mockRejectedValue(new StretchingReferenceError('ACTIVITY_NOT_FOUND'));
  const response = await app.inject({
    method: 'GET',
    url: `/stretching/targets?activityId=${activityId}`,
  });
  expect(response.statusCode).toBe(404);
  expect(listTargets).toHaveBeenCalledWith('athlete-1', activityId);
});
