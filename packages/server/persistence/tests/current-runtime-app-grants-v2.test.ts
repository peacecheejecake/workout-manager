import { beforeEach, expect, it, vi } from 'vitest';
import type * as BaselineModule from '../src/current-runtime-app-grants-v1.js';
const f = vi.hoisted(() => ({
  baseline: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  events: [] as string[],
}));
vi.mock('../src/current-runtime-app-grants-v1.js', async (original) => ({
  ...(await original<typeof BaselineModule>()),
  grantCurrentRuntimeAppBaselineV1: f.baseline,
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      f.events.push('pool');
    }
    query = f.query;
    end = f.end;
  },
}));
import { currentRuntimeAppGrantRecipeV1 } from '../src/current-runtime-app-grants-v1.js';
import {
  grantCurrentRuntimeAppBaselineV2,
  currentRuntimeAppGrantRecipeV2,
  currentRuntimeAppGarminConnectionColumnsV2,
} from '../src/current-runtime-app-grants-v2.js';
beforeEach(() => {
  vi.clearAllMocks();
  f.events.length = 0;
  f.baseline.mockImplementation(async (_url, role, deployment) => {
    f.events.push('v1');
    return {
      recipeVersion: 1,
      recipe: 'configured-app-baseline-v1',
      deployment,
      runtimeRole: role,
      atomicity: 'separate_existing_grant_transactions',
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    };
  });
  f.query.mockResolvedValue({ rows: [{ safe: true }] });
});
it('delegates original V1 first then adds precisely the required five-column SELECT', async () => {
  const value = await grantCurrentRuntimeAppBaselineV2('owner', 'app');
  expect(f.baseline).toHaveBeenCalledExactlyOnceWith('owner', 'app', 'core');
  expect(f.events).toEqual(['v1', 'pool']);
  expect(f.query.mock.calls[0]?.[1]).toEqual(['app']);
  expect(f.query.mock.calls[1]?.[0]).toBe(
    'GRANT SELECT(athlete_id,session_generation,state,schedule_enabled,schedule_paused) ON public.garmin_unofficial_connection TO "app"',
  );
  expect(value).toEqual({
    recipeVersion: 2,
    recipe: 'configured-app-baseline-v2',
    deployment: 'core',
    runtimeRole: 'app',
    atomicity: 'separate_existing_grant_transactions',
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  expect(f.end).toHaveBeenCalledOnce();
});
it('pins named recipe2 without changing V1 identity/order/append-only recipe', () => {
  expect(currentRuntimeAppGrantRecipeV2.repositoryOrder).toBe(
    currentRuntimeAppGrantRecipeV1.repositoryOrder,
  );
  expect(currentRuntimeAppGrantRecipeV1.recipeVersion).toBe(1);
  expect(currentRuntimeAppGrantRecipeV2.retainedUnofficialConnection).toEqual({
    relation: 'public.garmin_unofficial_connection',
    privilege: 'SELECT',
    columns: ['athlete_id', 'session_generation', 'state', 'schedule_enabled', 'schedule_paused'],
  });
  expect(Object.isFrozen(currentRuntimeAppGarminConnectionColumnsV2)).toBe(true);
});
it('preserves only explicit optional collector V1 delegation, no new pool or rights', async () => {
  const value = await grantCurrentRuntimeAppBaselineV2('owner', 'app', 'garmin-unofficial');
  expect(f.baseline).toHaveBeenCalledExactlyOnceWith('owner', 'app', 'garmin-unofficial');
  expect(f.events).toEqual(['v1']);
  expect(f.query).not.toHaveBeenCalled();
  expect(value.deployment).toBe('garmin-unofficial');
});
it.each(['APP_GRANT_INVALID_INPUT', 'APP_GRANT_UNSAFE_PRINCIPAL', 'partial V1 failure'])(
  'propagates original %s before any V2 grant',
  async (code) => {
    f.baseline.mockRejectedValueOnce(Error(code));
    await expect(grantCurrentRuntimeAppBaselineV2('owner', 'app')).rejects.toThrow(code);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  },
);
it.each([{ rows: [] }, { rows: [{ safe: false }] }, { rows: [{ safe: true, extra: true }] }])(
  'rejects changed principal observation after V1 without narrow grant',
  async ({ rows }) => {
    f.query.mockResolvedValue({ rows });
    await expect(grantCurrentRuntimeAppBaselineV2('owner', 'app')).rejects.toThrow(
      'APP_GRANT_UNSAFE_PRINCIPAL',
    );
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledOnce();
  },
);
it('does not grant credential/counter/lease/run/membership or core DML', async () => {
  await grantCurrentRuntimeAppBaselineV2('owner', 'app');
  const statements = f.query.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => sql.startsWith('GRANT'));
  expect(statements).toHaveLength(1);
  expect(statements.join('\n')).not.toMatch(
    /encrypted_session|profile_hash|login_|lease_|garmin_unofficial_run|INSERT|UPDATE|DELETE|TRUNCATE|WITH GRANT OPTION/,
  );
});
it('retains honest separate-transaction failure and closes the V2 pool', async () => {
  f.query
    .mockResolvedValueOnce({ rows: [{ safe: true }] })
    .mockRejectedValueOnce(Error('column grant failed'));
  await expect(grantCurrentRuntimeAppBaselineV2('owner', 'app')).rejects.toThrow(
    'column grant failed',
  );
  expect(f.baseline).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
  expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain('ROLLBACK');
});
