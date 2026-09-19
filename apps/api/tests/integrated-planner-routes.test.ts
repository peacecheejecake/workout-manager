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
const emptyReadV4 = {
  ...emptyRead,
  schemaVersion: 4 as const,
  recoveryStrategyVersionIds: [],
  routineScheduleVersionIds: [],
  days: emptyRead.days.map((day) => ({
    ...day,
    recoveryPlans: [],
    recoveryActions: [],
    routineOccurrences: [],
    routineRuns: [],
    stretchingActivityIds: [],
  })),
  summary: {
    ...emptySummary,
    recovery: { plannedStrategyCount: 0, actualActionCount: 0 },
    routines: { occurrenceCount: 0, runCount: 0 },
    stretchingActivityCount: 0,
  },
};
const url = '/planner/integrated?from=2026-09-18&toExclusive=2026-09-19&timezone=UTC';
function setup() {
  const app = Fastify();
  const repository = {
    read: vi.fn().mockResolvedValue(emptyRead),
    readV4: vi.fn().mockResolvedValue(emptyReadV4),
  };
  registerIntegratedPlannerRoutes(app, repository, () => ({
    athleteId: 'owner',
    sessionId: 'session',
    method: 'bearer',
  }));
  apps.push(app);
  return { app, repository };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it.each([url, `${url}&maxSchemaVersion=1`])(
  'preserves the legacy v1 read model for %s',
  async (requestUrl) => {
    const { app, repository } = setup();
    const response = await app.inject({ url: requestUrl });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(emptyRead);
    expect(repository.read).toHaveBeenCalledWith('owner', {
      from: '2026-09-18',
      toExclusive: '2026-09-19',
      timezone: 'UTC',
    });
    expect(repository.readV4).not.toHaveBeenCalled();
  },
);

it('validates bounded dates and derives tenant identity', async () => {
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

it('returns a schema-v4 read model only when the client explicitly supports version 4', async () => {
  const { app, repository } = setup();
  const response = await app.inject({ url: `${url}&maxSchemaVersion=4` });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(emptyReadV4);
  expect(repository.readV4).toHaveBeenCalledWith('owner', {
    from: '2026-09-18',
    toExclusive: '2026-09-19',
    timezone: 'UTC',
  });
  expect(repository.read).not.toHaveBeenCalled();
});

it.each([2, 3])(
  'rejects unsupported schema version %i without reading either model',
  async (version) => {
    const { app, repository } = setup();
    const response = await app.inject({ url: `${url}&maxSchemaVersion=${version}` });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('UNSUPPORTED_SCHEMA_VERSION');
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.readV4).not.toHaveBeenCalled();
  },
);

it('validates the repository v4 response instead of silently converting a legacy model', async () => {
  const { app, repository } = setup();
  repository.readV4.mockResolvedValueOnce(emptyRead);

  const response = await app.inject({ url: `${url}&maxSchemaVersion=4` });
  expect(response.statusCode).toBe(500);
  expect(repository.read).not.toHaveBeenCalled();
});

it('reports a complete-result limit instead of a silently truncated summary', async () => {
  const { app, repository } = setup();
  repository.read.mockRejectedValueOnce(new IntegratedPlannerLimitError());
  const result = await app.inject({ url });
  expect(result.statusCode).toBe(422);
  expect(result.json().message).toBe('PLANNER_RESULT_TOO_LARGE');
});
