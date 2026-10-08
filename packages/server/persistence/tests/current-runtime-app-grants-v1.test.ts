import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), order: [] as string[] }));
vi.mock('pg', () => ({
  Pool: class {
    query = f.query;
    end = f.end;
  },
}));
vi.mock(import('../src/migrate.js'), async (original) => {
  const module = await original();
  return Object.fromEntries(
    Object.entries(module).map(([name, value]) => [
      name,
      name.startsWith('grant')
        ? vi.fn(async () => {
            f.order.push(name);
          })
        : value,
    ]),
  );
});
import * as grants from '../src/migrate.js';
import {
  currentRuntimeAppGrantRecipeV1,
  grantCurrentRuntimeAppBaselineV1,
} from '../src/current-runtime-app-grants-v1.js';
beforeEach(() => {
  vi.clearAllMocks();
  f.order.length = 0;
  f.query.mockResolvedValue({ rows: [{ safe: true }] });
});
it('uses exact configured baseline order and separate seven-table Activity DML', async () => {
  const result = await grantCurrentRuntimeAppBaselineV1('owner', 'app');
  expect(f.order).toEqual([
    'grantIdentityFunctions',
    'grantAiSettings',
    'grantOperations',
    'grantCorePlanning',
    'grantNutritionCore',
    'grantSupplementaryCore',
    'grantRoutineCore',
    'grantStretchingCore',
    'grantRecoveryCore',
    'grantCheckIns',
    'grantSessionCompletions',
    'grantPlanScenarios',
    'grantCoachingConstraints',
    'grantCoachingThreads',
    'grantCoreEvidenceSnapshots',
    'grantCoachingRuns',
    'grantCoachingCandidates',
    'grantIntegratedApprovalV4',
    'grantResources',
    'grantResourceRetrieval',
    'grantGalleryMedia',
    'grantActivityTracks',
    'grantCourses',
    'grantRaces',
    'grantHealthKitIngestion',
    'grantGarmin',
  ]);
  expect(f.query.mock.calls.slice(1).map(([sql]) => sql)).toEqual([
    'GRANT SELECT,INSERT,UPDATE,DELETE ON public.activity_canonical,public.activity_source_head,public.activity_source_revision,public.activity_overlay,public.activity_overlay_revision,public.activity_suppression,public.activity_import_receipt TO "app"',
    'GRANT SELECT ON public.garmin_activity_ledger,public.garmin_activity_ledger_source TO "app"',
  ]);
  expect(grants.grantGarminUnofficial).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    deployment: 'core',
    supported: false,
    processingAuthority: 'none',
    atomicity: 'separate_existing_grant_transactions',
  });
  expect(currentRuntimeAppGrantRecipeV1.activityRelations).toHaveLength(7);
  expect(f.end).toHaveBeenCalledOnce();
});
it('optional collector is explicit and follows baseline; no worker or role membership grant', async () => {
  await grantCurrentRuntimeAppBaselineV1('owner', 'app', 'garmin-unofficial');
  expect(f.order.at(-1)).toBe('grantGarminUnofficial');
  expect(grants.grantGarminWorker).not.toHaveBeenCalled();
  expect(grants.grantCoachingRunWorker).not.toHaveBeenCalled();
  expect(
    f.query.mock.calls
      .slice(1)
      .map(([sql]) => sql)
      .join('\n'),
  ).not.toMatch(/plan_snapshot|plan_history|coaching_analysis_output|GRANT .* TO .* WITH/);
});
it.each([
  ['bad;role', 'core'],
  ['app', { profile: 'core' }],
  ['app', 'future'],
  ['OWNER', 'core'],
])('rejects unknown caller inputs before I/O', async (role, deployment) => {
  await expect(grantCurrentRuntimeAppBaselineV1('owner', role, deployment)).rejects.toThrow(
    'APP_GRANT_INVALID_INPUT',
  );
  expect(f.query).not.toHaveBeenCalled();
  expect(f.order).toEqual([]);
});
it.each([{ rows: [] }, { rows: [{ safe: false }] }, { rows: [{ safe: true, extra: true }] }])(
  'rejects unsafe principal observation before any grant',
  async ({ rows }) => {
    f.query.mockResolvedValue({ rows });
    await expect(grantCurrentRuntimeAppBaselineV1('owner', 'app')).rejects.toThrow(
      'APP_GRANT_UNSAFE_PRINCIPAL',
    );
    expect(f.order).toEqual([]);
    expect(f.end).toHaveBeenCalledOnce();
  },
);
it('propagates partial failure without claiming rollback or continuing later grants', async () => {
  vi.mocked(grants.grantNutritionCore).mockRejectedValueOnce(new Error('grant failure'));
  await expect(grantCurrentRuntimeAppBaselineV1('owner', 'app')).rejects.toThrow('grant failure');
  expect(f.order).toEqual([
    'grantIdentityFunctions',
    'grantAiSettings',
    'grantOperations',
    'grantCorePlanning',
  ]);
  expect(f.query).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
});
it('reuses actual core planning SQL with append-only snapshot and history rights', async () => {
  const actual = await vi.importActual<typeof grants>('../src/migrate.js');
  f.query.mockImplementation(async (sql: string) =>
    sql.includes('to_regprocedure') ? { rows: [{ available: false }] } : { rows: [] },
  );
  await actual.grantCorePlanning('owner', 'app');
  const sql = f.query.mock.calls.map(([value]) => value);
  expect(sql).toContain('GRANT SELECT,INSERT ON plan_snapshot,plan_history TO "app"');
  expect(
    sql.filter((value) => value.startsWith('GRANT') && /plan_snapshot|plan_history/.test(value)),
  ).toEqual(['GRANT SELECT,INSERT ON plan_snapshot,plan_history TO "app"']);
});
