import { beforeEach, expect, it, vi } from 'vitest';
import type * as ReadinessModule from '@workout/server-persistence/current-runtime-readiness-v9';
import type * as BundleModule from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import type * as OperationsModule from '@workout/server-persistence/operations';
import type { Database, CatalogTransaction } from '@workout/server-persistence/database';
import { createRaceManualPooledPublicRepositoryV2 } from '@workout/server-persistence/race-manual-pooled-bundle-v2';
import { createOperationsV38PooledRepository } from '@workout/server-persistence/operations';
import {
  createCurrentRuntimeV9Repositories,
  CurrentRuntimeV9RepositoriesError,
} from '../src/current-runtime-v9-repositories.js';

const mocks = vi.hoisted(() => ({
  probe: vi.fn<(database: Database) => Promise<unknown>>(),
}));
vi.mock('@workout/server-persistence/current-runtime-readiness-v9', async (original) => {
  const actual = await original<typeof ReadinessModule>();
  return { ...actual, probeCurrentRuntimeReadinessV9: mocks.probe };
});
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
const publicFactory = vi.mocked(createRaceManualPooledPublicRepositoryV2);
const operationsFactory = vi.mocked(createOperationsV38PooledRepository);
const ready = {
  schemaVersion: 1,
  state: 'ready',
  reason: 'verified_catalog_and_source',
  profileVersion: 9,
  runtimeStep: 25,
  sourceDdlTip: 142,
  protocol: 'named-profile25-pooled-v2-v38',
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
it('delegates only to the actual named V2/pooledV38 factories after the closed probe', async () => {
  const database = fixture();
  const repositories = await createCurrentRuntimeV9Repositories(database);
  expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(database);
  expect(publicFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(operationsFactory).toHaveBeenCalledExactlyOnceWith(database);
  expect(Object.keys(repositories)).toEqual(['raceManualPublic', 'operations']);
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
  const pending = createCurrentRuntimeV9Repositories(fixture());
  expect(publicFactory).not.toHaveBeenCalled();
  expect(operationsFactory).not.toHaveBeenCalled();
  finish(ready);
  await pending;
  expect(publicFactory).toHaveBeenCalledOnce();
});
it.each([
  ['unavailable', 'snapshot_unavailable', 'CURRENT_RUNTIME_V9_UNAVAILABLE'],
  ['unavailable', 'transaction_failed', 'CURRENT_RUNTIME_V9_UNAVAILABLE'],
  ['unsupported', 'catalog_mismatch', 'CURRENT_RUNTIME_V9_INCOMPATIBLE'],
  ['unsupported', 'source_drift', 'CURRENT_RUNTIME_V9_INCOMPATIBLE'],
])(
  'refuses %s readiness without injecting any latest or legacy fallback',
  async (state, reason, code) => {
    mocks.probe.mockResolvedValue({ ...ready, state, reason });
    await expect(createCurrentRuntimeV9Repositories(fixture())).rejects.toMatchObject({ code });
    expect(publicFactory).not.toHaveBeenCalled();
    expect(operationsFactory).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  { ...ready, profileVersion: 8 },
  { ...ready, runtimeStep: 24 },
  { ...ready, sourceDdlTip: 141 },
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
    await expect(createCurrentRuntimeV9Repositories(fixture())).rejects.toMatchObject({
      code: 'CURRENT_RUNTIME_V9_INVALID_READINESS',
    });
    expect(publicFactory).not.toHaveBeenCalled();
    expect(operationsFactory).not.toHaveBeenCalled();
  },
);
it('sanitizes unexpected probe failure and leaves the configured database lifecycle owned by its caller', async () => {
  mocks.probe.mockRejectedValue(Error('synthetic sensitive driver details'));
  const database = fixture();
  await expect(createCurrentRuntimeV9Repositories(database)).rejects.toEqual(
    new CurrentRuntimeV9RepositoriesError('CURRENT_RUNTIME_V9_UNAVAILABLE'),
  );
  expect(database.close).not.toHaveBeenCalled();
  expect(publicFactory).not.toHaveBeenCalled();
});
it('actual repositories retain strict command DTO and mandatory fresh snapshot guards', async () => {
  const database = fixture();
  const repositories = await createCurrentRuntimeV9Repositories(database);
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
  const repositories = await createCurrentRuntimeV9Repositories(withSnapshot);
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
  await expect(createCurrentRuntimeV9Repositories(fixture())).rejects.toMatchObject({
    code: 'CURRENT_RUNTIME_V9_INVALID_READINESS',
  });
  expect(getter).not.toHaveBeenCalled();
  mocks.probe.mockResolvedValue({ ...ready, reason: 'x'.repeat(4097) });
  await expect(createCurrentRuntimeV9Repositories(fixture())).rejects.toMatchObject({
    code: 'CURRENT_RUNTIME_V9_INVALID_READINESS',
  });
  expect(publicFactory).not.toHaveBeenCalled();
  expect(operationsFactory).not.toHaveBeenCalled();
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
      expect(publicFactory).not.toHaveBeenCalled();
      return ready;
    });
  });
  const repositories = await createCurrentRuntimeV9Repositories(database);
  expect(active).toBe(false);
  await expect(query()).rejects.toThrow('CATALOG_TRANSACTION_CLOSED');
  expect(repositories.raceManualPublic).toBeDefined();
  expect(database.close).not.toHaveBeenCalled();
});
