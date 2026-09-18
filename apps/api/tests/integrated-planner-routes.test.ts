import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { IntegratedPlannerLimitError } from '@workout/server-persistence/integrated-planner';
import { registerIntegratedPlannerRoutes } from '../src/integrated-planner-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
const emptyMetric = { value: null, knownCount: 0, missingCount: 0 };
const emptySummary = {
  training: {
    plannedSessionCount: 0,
    actualActivityCount: 0,
    supplementaryActivityCount: 0,
    distanceMeters: emptyMetric,
    durationSeconds: {
      timer: emptyMetric,
      elapsed: emptyMetric,
      moving: emptyMetric,
      unknown: emptyMetric,
    },
  },
  nutrition: {
    plannedItemCount: 0,
    intakeCount: 0,
    nutrients: {
      energyKcal: emptyMetric,
      carbohydrateGrams: emptyMetric,
      proteinGrams: emptyMetric,
      fatGrams: emptyMetric,
      fluidMl: emptyMetric,
      sodiumMg: emptyMetric,
    },
    intakeCoverage: 'unknown' as const,
  },
};
const emptyRead = {
  schemaVersion: 1 as const,
  from: '2026-09-18',
  toExclusive: '2026-09-19',
  timezone: 'UTC',
  trainingPlanVersionId: null,
  nutritionPlanVersionIds: [],
  days: [
    {
      date: '2026-09-18',
      plannedSessions: [],
      nutritionItems: [],
      activities: [],
      intakes: [],
      summary: emptySummary,
    },
  ],
  unresolvedNutritionItems: [],
  unplacedActivityCount: 0,
  summary: emptySummary,
};
const url = '/planner/integrated?from=2026-09-18&toExclusive=2026-09-19&timezone=UTC';
function setup() {
  const app = Fastify();
  const repository = { read: vi.fn().mockResolvedValue(emptyRead) };
  registerIntegratedPlannerRoutes(app, repository, () => ({
    athleteId: 'owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, repository };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it('validates bounded dates, derives tenant identity, and returns the integrated read model', async () => {
  const { app, repository } = setup();
  const valid = await app.inject({ url });
  expect(valid.statusCode).toBe(200);
  expect(valid.json()).toEqual(emptyRead);
  expect(repository.read).toHaveBeenCalledWith('owner', {
    from: '2026-09-18',
    toExclusive: '2026-09-19',
    timezone: 'UTC',
  });
  for (const invalid of [
    `${url}&athleteId=foreign`,
    '/planner/integrated?from=2026-09-18&toExclusive=2026-12-22&timezone=UTC',
    '/planner/integrated?from=2026-09-18&toExclusive=2026-09-19&timezone=Invalid/Zone',
  ])
    expect((await app.inject({ url: invalid })).statusCode).toBe(400);
  expect(repository.read).toHaveBeenCalledTimes(1);
});

it('reports a complete-result limit instead of a silently truncated summary', async () => {
  const { app, repository } = setup();
  repository.read.mockRejectedValueOnce(new IntegratedPlannerLimitError());
  const result = await app.inject({ url });
  expect(result.statusCode).toBe(422);
  expect(result.json().message).toBe('PLANNER_RESULT_TOO_LARGE');
});
