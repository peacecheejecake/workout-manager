import { beforeEach, expect, it, vi } from 'vitest';
import type * as ReadinessModule from '@workout/server-persistence/current-runtime-source-build-readiness-v2';
import type * as BundleModule from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import type * as OperationsModule from '@workout/server-persistence/operations';
import type * as NutritionWriterModule from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import type * as NutritionPreviewModule from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import type * as RaceResultModule from '@workout/server-persistence/race-result-v2';
import { createNutritionRacePlanV4Writer } from '@workout/server-persistence/nutrition-race-plan-v4-writer';
import { createNutritionRacePlanV4PreviewRepository } from '@workout/server-persistence/nutrition-race-plan-v4-preview';
import { createRaceResultV2Repository } from '@workout/server-persistence/race-result-v2';
import type { Database, CatalogTransaction } from '@workout/server-persistence/database';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV38PooledRepository } from '@workout/server-persistence/operations';
import {
  createCurrentRuntimeSourceBuildRepositoriesV2,
  CurrentRuntimeSourceBuildRepositoriesV2Error,
} from '../src/current-runtime-source-build-repositories-v2.js';

const mocks = vi.hoisted(() => ({
  probe: vi.fn<(database: Database) => Promise<unknown>>(),
}));
vi.mock(
  '@workout/server-persistence/current-runtime-source-build-readiness-v2',
  async (original) => {
    const actual = await original<typeof ReadinessModule>();
    return { ...actual, probeCurrentRuntimeSourceBuildReadinessV2: mocks.probe };
  },
);
vi.mock('@workout/server-persistence/race-manual-pooled-bundle-v2', async (original) => {
  const actual = await original<typeof BundleModule>();
  return {
    ...actual,
    createRaceManualPooledPublicRepositoryV2: vi.fn(
      actual.createRaceManualPooledPublicRepositoryV2,
    ),
  };
});
vi.mock('@workout/server-persistence/operations', async (original) => {
  const actual = await original<typeof OperationsModule>();
  return {
    ...actual,
    createOperationsV38PooledRepository: vi.fn(actual.createOperationsV38PooledRepository),
  };
});
vi.mock('@workout/server-persistence/nutrition-race-plan-v4-writer', async (original) => {
  const actual = await original<typeof NutritionWriterModule>();
  return {
    ...actual,
    createNutritionRacePlanV4Writer: vi.fn(actual.createNutritionRacePlanV4Writer),
  };
});
vi.mock('@workout/server-persistence/nutrition-race-plan-v4-preview', async (original) => {
  const actual = await original<typeof NutritionPreviewModule>();
  return {
    ...actual,
    createNutritionRacePlanV4PreviewRepository: vi.fn(
      actual.createNutritionRacePlanV4PreviewRepository,
    ),
  };
});
vi.mock('@workout/server-persistence/race-result-v2', async (original) => {
  const actual = await original<typeof RaceResultModule>();
  return { ...actual, createRaceResultV2Repository: vi.fn(actual.createRaceResultV2Repository) };
});
const publicFactory = vi.mocked(createRaceManualPooledPublicRepositoryV2);
const operationsFactory = vi.mocked(createOperationsV38PooledRepository);
const nutritionWriterFactory = vi.mocked(createNutritionRacePlanV4Writer);
const nutritionPreviewFactory = vi.mocked(createNutritionRacePlanV4PreviewRepository);
const raceResultFactory = vi.mocked(createRaceResultV2Repository);
const factories = [
  publicFactory,
  operationsFactory,
  nutritionWriterFactory,
  nutritionPreviewFactory,
  raceResultFactory,
];
function expectNoPorts() {
  for (const factory of factories) expect(factory).not.toHaveBeenCalled();
}
const ready = {
  schemaVersion: 2,
  buildProofVersion: 2,
  sourceBuildRevision: 1,
  currentFunctionalExecution: 'not_executed',
  approvalAllowed: false,
  restoreAuthority: 'none',
  state: 'ready',
  reason: 'verified_catalog_and_source',
  profileVersion: 10,
  runtimeStep: 26,
  sourceDdlTip: 146,
  protocol: 'named-profile26-pooled-v2-v38',
  processingAuthority: 'none',
  restore: 'not_verified',
  installationReceiptRows: 'not_observed_by_runtime',
};
function fixture(): Database {
  return {
    tenant: vi.fn(async () => {
      throw Error('TENANT_ADMISSION_REQUIRED');
    }),
    exclusiveTenant: vi.fn(async () => {
      throw Error('EXCLUSIVE_ADMISSION_REQUIRED');
    }),
    close: vi.fn(async () => undefined),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.probe.mockResolvedValue(ready);
});
it('delegates to all five actual named factories only after the closed probe', async () => {
  const database = fixture();
  const repositories = await createCurrentRuntimeSourceBuildRepositoriesV2(database);
  expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(database);
  expect(publicFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(operationsFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(nutritionWriterFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(nutritionPreviewFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(raceResultFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(Object.keys(repositories)).toEqual([
    'raceManualPublic',
    'operations',
    'nutritionV4Writer',
    'nutritionV4Preview',
    'raceResultsV2',
  ]);
  expect(repositories.nutritionV4Writer).toBe(nutritionWriterFactory.mock.results[0]?.value);
  expect(repositories.nutritionV4Preview).toBe(nutritionPreviewFactory.mock.results[0]?.value);
  expect(repositories.raceResultsV2).toBe(raceResultFactory.mock.results[0]?.value);
  for (const factory of factories) {
    expect(factory.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.probe.mock.invocationCallOrder[0] ?? 0,
    );
  }
  expect(database.close).not.toHaveBeenCalled();
  expect(publicFactory.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.probe.mock.invocationCallOrder[0] ?? 0,
  );
});
it('does not construct ports while catalog readiness is pending', async () => {
  let finish: (value: unknown) => void = () => {
    throw Error('NOT_PENDING');
  };
  mocks.probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = createCurrentRuntimeSourceBuildRepositoriesV2(fixture());
  expectNoPorts();
  finish(ready);
  await pending;
  for (const factory of factories) expect(factory).toHaveBeenCalledOnce();
});
it.each([
  ['unavailable', 'snapshot_unavailable', 'CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE'],
  ['unavailable', 'transaction_failed', 'CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE'],
  ['unsupported', 'catalog_mismatch', 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INCOMPATIBLE'],
  ['unsupported', 'source_drift', 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INCOMPATIBLE'],
])(
  'refuses %s readiness without injecting any latest or legacy fallback',
  async (state, reason, code) => {
    mocks.probe.mockResolvedValue({ ...ready, state, reason });
    await expect(createCurrentRuntimeSourceBuildRepositoriesV2(fixture())).rejects.toMatchObject({
      code,
    });
    expectNoPorts();
  },
);
it.each([
  null,
  { ...ready, schemaVersion: 1 },
  { ...ready, profileVersion: 9 },
  { ...ready, buildProofVersion: 1 },
  { ...ready, sourceBuildRevision: 2 },
  { ...ready, currentFunctionalExecution: 'passed' },
  { ...ready, approvalAllowed: true },
  { ...ready, restoreAuthority: 'verified' },
  { ...ready, runtimeStep: 25 },
  { ...ready, sourceDdlTip: 142 },
  { ...ready, protocol: 'named-profile25-pooled-v2-v38' },
  {
    ...ready,
    buildProofVersion: 1,
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    protocol: 'named-profile25-pooled-v2-v38',
  },
  { ...ready, protocol: 'legacy' },
  { ...ready, processingAuthority: 'authorized' },
  { ...ready, restore: 'verified' },
  { ...ready, installationReceiptRows: 'caller_proof' },
  { ...ready, reason: 'catalog_mismatch' },
  { ...ready, supported: true },
])(
  'rejects malformed, foreign profile or fabricated authority observations',
  async (observation) => {
    mocks.probe.mockResolvedValue(observation);
    await expect(createCurrentRuntimeSourceBuildRepositoriesV2(fixture())).rejects.toMatchObject({
      code: 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
    });
    expectNoPorts();
  },
);
it('sanitizes unexpected probe failure and leaves the configured database lifecycle owned by its caller', async () => {
  mocks.probe.mockRejectedValue(Error('synthetic sensitive driver details'));
  const database = fixture();
  await expect(createCurrentRuntimeSourceBuildRepositoriesV2(database)).rejects.toEqual(
    new CurrentRuntimeSourceBuildRepositoriesV2Error('CURRENT_RUNTIME_SOURCE_BUILD_V2_UNAVAILABLE'),
  );
  expect(database.close).not.toHaveBeenCalled();
  expectNoPorts();
});
it('actual repositories retain strict command DTO and mandatory fresh snapshot guards', async () => {
  const database = fixture();
  const repositories = await createCurrentRuntimeSourceBuildRepositoriesV2(database);
  expect(() =>
    repositories.raceManualPublic.approve('synthetic-athlete', {
      confirmed: true,
      callerBasis: {},
    }),
  ).toThrow();
  await expect(
    repositories.raceManualPublic.review('synthetic-athlete', { privateContext: {} }),
  ).rejects.toThrow();
  expect(() => repositories.operations.exportAccount('synthetic-athlete')).toThrow(
    'OPERATIONS_SNAPSHOT_REQUIRED',
  );
  expect(database.tenant).not.toHaveBeenCalled();
  expect(database.exclusiveTenant).not.toHaveBeenCalled();
});
it('a fresh snapshot admission failure propagates on each command after startup readiness', async () => {
  const database = fixture();
  const snapshot = vi.fn(async () => {
    throw Error('FRESH_COMMAND_ADMISSION_REQUIRED');
  });
  const withSnapshot: Database = { ...database, snapshotTenant: snapshot };
  const repositories = await createCurrentRuntimeSourceBuildRepositoriesV2(withSnapshot);
  const id = '00000000-0000-4000-8000-000000000001';
  await expect(repositories.raceManualPublic.readPreview('synthetic-athlete', id)).rejects.toThrow(
    'FRESH_COMMAND_ADMISSION_REQUIRED',
  );
  await expect(repositories.operations.exportAccount('synthetic-athlete')).rejects.toThrow(
    'FRESH_COMMAND_ADMISSION_REQUIRED',
  );
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(database.close).not.toHaveBeenCalled();
});

it('rejects getter or oversized readiness observations before schema access', async () => {
  const getter = vi.fn(() => 'ready');
  const observed = { ...ready };
  Object.defineProperty(observed, 'state', { enumerable: true, get: getter });
  mocks.probe.mockResolvedValue(observed);
  await expect(createCurrentRuntimeSourceBuildRepositoriesV2(fixture())).rejects.toMatchObject({
    code: 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
  });
  expect(getter).not.toHaveBeenCalled();
  mocks.probe.mockResolvedValue({ ...ready, reason: 'x'.repeat(4097) });
  await expect(createCurrentRuntimeSourceBuildRepositoriesV2(fixture())).rejects.toMatchObject({
    code: 'CURRENT_RUNTIME_SOURCE_BUILD_V2_INVALID_READINESS',
  });
  expectNoPorts();
});

it('awaits catalog snapshot closure before exposing ports and never retains its transaction', async () => {
  let active = false;
  const query = vi.fn(async () => {
    if (!active) throw Error('CATALOG_TRANSACTION_CLOSED');
    return { rows: [], rowCount: 0 };
  });
  const database: Database = {
    ...fixture(),
    async snapshotCatalog<T>(apply: (transaction: CatalogTransaction) => Promise<T>): Promise<T> {
      active = true;
      try {
        return await apply({ query });
      } finally {
        active = false;
      }
    },
  };
  mocks.probe.mockImplementation(async (db) => {
    if (!db.snapshotCatalog) throw Error('SNAPSHOT_UNAVAILABLE');
    return db.snapshotCatalog(async (tx) => {
      await tx.query('SELECT catalog_metadata_only');
      expectNoPorts();
      return ready;
    });
  });
  const repositories = await createCurrentRuntimeSourceBuildRepositoriesV2(database);
  expect(active).toBe(false);
  await expect(query()).rejects.toThrow('CATALOG_TRANSACTION_CLOSED');
  expect(repositories.raceManualPublic).toBeDefined();
  expect(database.close).not.toHaveBeenCalled();
});
