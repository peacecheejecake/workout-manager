import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentRuntimeTargetTransforms } from '@workout/server-persistence/current-runtime-installation';
import { currentRuntimeAppGrantRecipeV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import type { Database } from '@workout/server-persistence/database';
import {
  composeIdentityInstalledCurrentRuntimeV11Ports,
  setupIdentityInstalledCurrentRuntimeV11,
} from '../../../scripts/identity-installed-current-runtime-v11.mjs';

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  baseline: vi.fn(),
  grant: vi.fn(),
  worker: vi.fn(),
  dispatcher: vi.fn(),
  writer: vi.fn(),
  preview: vi.fn(),
  results: vi.fn(),
  publicRace: vi.fn(),
  batch: vi.fn(),
  oldOperations: vi.fn(),
}));
// The V11 installer and grants belong to lane I. Until root registers them, this suite
// mocks both modules whole with synthetic pinned constants of the agreed shape (V10 parent
// manifest, profile27 extension roster 143-148, the V11 RPC roster); the setup must compare
// observed rows to whatever the installer module exports, never to fixed counts.
const pinned = vi.hoisted(() => {
  const hex = (digit: string) => digit.repeat(64);
  const extensionMembers = Object.freeze(
    (
      [
        [143, '143_gallery_albums.sql'],
        [144, '144_gallery_renditions.sql'],
        [145, '145_gallery_restore_suppression.sql'],
        [147, '147_restore_processing_admission.sql'],
        [148, '148_ai_execution_job_store.sql'],
      ] as const
    ).map(([sourceDdlId, filename], index) =>
      Object.freeze({
        extensionStep: index + 1,
        sourceDdlId,
        filename,
        sha256: hex(String(index + 1)),
      }),
    ),
  );
  const parentMembers = Object.freeze(
    Array.from({ length: 33 }, (_, index) =>
      Object.freeze({
        step: index + 1,
        sourceDdlId: 108 + index,
        filename: `${108 + index}_synthetic_parent.sql`,
        sha256: hex('a'),
      }),
    ),
  );
  const rpcSignatures = Object.freeze(
    Array.from({ length: 50 }, (_, index) => `public.synthetic_rpc_${index}_v1(uuid)`),
  );
  return { extensionMembers, parentMembers, parentManifestSha256: hex('b'), rpcSignatures };
});
vi.mock('@workout/server-persistence/current-runtime-installation-v11', () => ({
  installCurrentRuntimeV11: mocks.install,
  currentRuntimeV11ExtensionMembers: pinned.extensionMembers,
  currentRuntimeV11ParentMembers: pinned.parentMembers,
  currentRuntimeV11ParentManifestSha256: pinned.parentManifestSha256,
}));
vi.mock('@workout/server-persistence/current-runtime-grants-v11', () => ({
  grantCurrentRuntimeV11Profile: mocks.grant,
  grantCurrentRuntimeV11GalleryWorker: mocks.worker,
  grantCurrentRuntimeV11AiDispatcher: mocks.dispatcher,
  currentRuntimeV11GalleryWorkerRole: 'workout_gallery_rendition_worker',
  currentRuntimeV11AiDispatcherRole: 'workout_ai_dispatcher',
  currentRuntimeV11WorkerRpcSignatures: ['public.synthetic_worker_rpc_v1(uuid)'],
  currentRuntimeV11AiDispatcherTableGrants: [{ table: 'synthetic', privileges: ['SELECT'] }],
  currentRuntimeV11RpcSignatures: pinned.rpcSignatures,
}));
const currentRuntimeV11ExtensionMembers = pinned.extensionMembers;
const currentRuntimeV11ParentMembers = pinned.parentMembers;
const currentRuntimeV11ParentManifestSha256 = pinned.parentManifestSha256;
const currentRuntimeV11RpcSignatures = pinned.rpcSignatures;
vi.mock('@workout/server-persistence/current-runtime-app-grants-v2', async (original) => ({
  ...(await original<object>()),
  grantCurrentRuntimeAppBaselineV2: mocks.baseline,
}));
vi.mock('@workout/server-persistence/nutrition-race-plan-v4-writer', () => ({
  createNutritionRacePlanV4Writer: mocks.writer,
}));
vi.mock('@workout/server-persistence/nutrition-race-plan-v4-preview', () => ({
  createNutritionRacePlanV4PreviewRepository: mocks.preview,
}));
vi.mock('@workout/server-persistence/race-result-v2', () => ({
  createRaceResultV2Repository: mocks.results,
}));
vi.mock('@workout/server-persistence/race-manual-pooled-bundle-v2', () => ({
  createRaceManualPooledPublicRepositoryV2: mocks.publicRace,
}));
vi.mock('@workout/server-persistence/operations', () => ({
  createOperationsV40PooledRepository: mocks.batch,
  createOperationsV38PooledRepository: mocks.oldOperations,
}));

const input = {
  ownerConnectionString: 'postgresql://owner:synthetic@127.0.0.1:5432/disposable',
  runtimeRole: 'fixture_app',
};
function installed() {
  return {
    profileVersion: 11,
    parentProfileVersion: 10,
    baselineSchemaVersion: 107,
    parentRuntimeStep: 26,
    extensionSteps: currentRuntimeV11ExtensionMembers.length,
    runtimeStep: 27,
    sourceDdlTip: 148,
    parentManifestSha256: currentRuntimeV11ParentManifestSha256,
    extensionMembers: currentRuntimeV11ExtensionMembers,
    extensionReceipts: currentRuntimeV11ExtensionMembers.map((member) => ({
      ...member,
      parentManifestSha256: currentRuntimeV11ParentManifestSha256,
    })),
    parentAppliedMembers: currentRuntimeV11ParentMembers,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  };
}
function granted() {
  return {
    installation: installed(),
    runtimeRole: input.runtimeRole,
    grantedFunctions: currentRuntimeV11RpcSignatures,
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.install.mockResolvedValue(installed());
  mocks.baseline.mockResolvedValue({
    recipeVersion: 2,
    recipe: currentRuntimeAppGrantRecipeV2.name,
    deployment: 'core',
    runtimeRole: input.runtimeRole,
    atomicity: 'separate_existing_grant_transactions',
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  mocks.grant.mockResolvedValue(granted());
  mocks.worker.mockResolvedValue({
    workerRole: 'workout_gallery_rendition_worker',
    grantedFunctions: ['public.synthetic_worker_rpc_v1(uuid)'],
  });
  mocks.dispatcher.mockResolvedValue({
    dispatcherRole: 'workout_ai_dispatcher',
    grantedTables: [{ table: 'synthetic', privileges: ['SELECT'] }],
  });
});
describe('explicit disposable profile27 composition', () => {
  it('installs27 then named core baseline then exact V11 grants, without activation', async () => {
    const result = await setupIdentityInstalledCurrentRuntimeV11(input);
    expect(mocks.install).toHaveBeenCalledWith(input.ownerConnectionString);
    expect(mocks.baseline).toHaveBeenCalledWith(
      input.ownerConnectionString,
      input.runtimeRole,
      'core',
    );
    expect(mocks.grant).toHaveBeenCalledWith(input.ownerConnectionString, input.runtimeRole);
    expect(mocks.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.baseline.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.baseline.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.grant.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.worker).toHaveBeenCalledWith(
      input.ownerConnectionString,
      'workout_gallery_rendition_worker',
    );
    expect(mocks.dispatcher).toHaveBeenCalledWith(
      input.ownerConnectionString,
      'workout_ai_dispatcher',
    );
    expect(mocks.grant.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.worker.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toMatchObject({
      fixtureMode: 'installed-current-profile27',
      rpcCount: currentRuntimeV11RpcSignatures.length,
      profileVersion: 11,
      runtimeStep: 27,
      sourceDdlTip: 148,
      sourceExportBatch: 'installed_profile27_pooled_v40',
      productionActivation: false,
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty('ownerConnectionString');
  });
  it.each([
    null,
    { ...input, extra: true },
    { ...input, runtimeRole: 'Bad;role' },
    { ...input, ownerConnectionString: 'postgresql://owner@remote.invalid/db' },
    { ...input, ownerConnectionString: 'https://owner@localhost/db' },
    { ...input, ownerConnectionString: 'postgresql://owner@localhost/db?x=1' },
    { ...input, ownerConnectionString: 'postgresql://owner@localhost/db#secret' },
    { ...input, ownerConnectionString: 'postgresql://localhost/db' },
    { ...input, ownerConnectionString: 'x'.repeat(9000) },
  ])('rejects unknown or nonlocal input before I/O %#', async (raw) => {
    await expect(setupIdentityInstalledCurrentRuntimeV11(raw)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_INPUT_INVALID',
    });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('does not execute an ingress getter', async () => {
    const getter = vi.fn();
    await expect(
      setupIdentityInstalledCurrentRuntimeV11({
        get ownerConnectionString() {
          getter();
          return input.ownerConnectionString;
        },
        runtimeRole: input.runtimeRole,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CURRENT_INPUT_INVALID' });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { supported: true },
    { runtimeStep: 26 },
    { profileVersion: 10 },
    { parentProfileVersion: 9 },
    { sourceDdlTip: 146 },
    { sourceDdlTip: 147 },
    { parentRuntimeStep: 25 },
    { extensionSteps: 1 },
    { parentManifestSha256: currentRuntimeV11ParentManifestSha256.slice(1) },
    {
      extensionReceipts: installed().extensionReceipts.map((receipt, index) =>
        index === 0 ? { ...receipt, sourceDdlId: 146 } : receipt,
      ),
    },
    { extensionReceipts: installed().extensionReceipts.slice(1) },
    {
      extensionMembers: currentRuntimeV11ExtensionMembers.map((member, index) =>
        index === 0 ? { ...member, sha256: '0'.repeat(64) } : member,
      ),
    },
    { extensionMembers: [...currentRuntimeV11ExtensionMembers].reverse() },
    { extensionMembers: currentRuntimeV11ExtensionMembers.slice(0, -1) },
    { parentAppliedMembers: [] },
    { parentAppliedMembers: currentRuntimeV11ParentMembers.slice(0, -1) },
    { unknown: true },
  ])('rejects malformed installation before baseline %#', async (change) => {
    mocks.install.mockResolvedValue({ ...installed(), ...change });
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(mocks.baseline).not.toHaveBeenCalled();
  });
  it.each([
    { grantedFunctions: currentRuntimeV11RpcSignatures.slice(0, -1) },
    { grantedFunctions: [...currentRuntimeV11RpcSignatures].reverse() },
    { grantedFunctions: [...currentRuntimeV11RpcSignatures, 'public.extra_v1(uuid)'] },
    { supported: true },
    { runtimeRole: 'another_app' },
    { unknown: true },
  ])('rejects nonexact final grant response %#', async (change) => {
    mocks.grant.mockResolvedValue({ ...granted(), ...change });
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
  });
  it('stops after invalid named baseline', async () => {
    mocks.baseline.mockResolvedValue({ recipeVersion: 2, supported: true });
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('propagates installation failure with no later grants', async () => {
    const error = new Error('installation failed');
    mocks.install.mockRejectedValue(error);
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toBe(error);
    expect(mocks.baseline).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('propagates grant failure; disposable caller owns teardown of committed baseline', async () => {
    const error = new Error('grant failed');
    mocks.grant.mockRejectedValue(error);
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toBe(error);
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.baseline).toHaveBeenCalledTimes(1);
  });
  it('connects trusted Database to actual named batch and domain factories', () => {
    const database: Database = { tenant: vi.fn(), exclusiveTenant: vi.fn(), close: vi.fn() };
    mocks.batch.mockReturnValue('batch');
    mocks.writer.mockReturnValue('writer');
    mocks.preview.mockReturnValue('preview');
    mocks.results.mockReturnValue('results');
    mocks.publicRace.mockReturnValue('race');
    expect(composeIdentityInstalledCurrentRuntimeV11Ports(database)).toEqual({
      operations: 'batch',
      nutritionV4Writer: 'writer',
      nutritionV4Preview: 'preview',
      raceResultsV2: 'results',
      raceManualPublic: 'race',
    });
    for (const factory of [
      mocks.batch,
      mocks.writer,
      mocks.preview,
      mocks.results,
      mocks.publicRace,
    ])
      expect(factory).toHaveBeenCalledWith(database);
    expect(mocks.oldOperations).not.toHaveBeenCalled();
  });
});

describe('profile27 fixed principals', () => {
  it('rejects a worker grant result that differs from the pinned worker RPCs', async () => {
    mocks.worker.mockResolvedValue({
      workerRole: 'workout_gallery_rendition_worker',
      grantedFunctions: [],
    });
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toThrow(
      'IDENTITY_CURRENT_PROFILE_INVALID',
    );
  });
  it('rejects a dispatcher grant result for another role', async () => {
    mocks.dispatcher.mockResolvedValue({
      dispatcherRole: 'other_role',
      grantedTables: [{ table: 'synthetic', privileges: ['SELECT'] }],
    });
    await expect(setupIdentityInstalledCurrentRuntimeV11(input)).rejects.toThrow(
      'IDENTITY_CURRENT_PROFILE_INVALID',
    );
  });
});
