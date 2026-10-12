import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10ParentMembers,
  currentRuntimeV10ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v10';
import { currentRuntimeTargetTransforms } from '@workout/server-persistence/current-runtime-installation';
import { currentRuntimeV10RpcSignatures } from '@workout/server-persistence/current-runtime-grants-v10';
import { currentRuntimeAppGrantRecipeV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import type { Database } from '@workout/server-persistence/database';
import {
  composeIdentityInstalledCurrentRuntimeV10Ports,
  setupIdentityInstalledCurrentRuntimeV10,
} from '../../../scripts/identity-installed-current-runtime-v10.mjs';

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  baseline: vi.fn(),
  grant: vi.fn(),
  writer: vi.fn(),
  preview: vi.fn(),
  results: vi.fn(),
  publicRace: vi.fn(),
  batch: vi.fn(),
  oldOperations: vi.fn(),
}));
vi.mock('@workout/server-persistence/current-runtime-installation-v10', async (original) => ({
  ...(await original<object>()),
  installCurrentRuntimeV10: mocks.install,
}));
vi.mock('@workout/server-persistence/current-runtime-grants-v10', async (original) => ({
  ...(await original<object>()),
  grantCurrentRuntimeV10Profile: mocks.grant,
}));
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
  createOperationsV38PooledRepository: mocks.batch,
  createOperationsV38Repository: mocks.oldOperations,
}));

const input = {
  ownerConnectionString: 'postgresql://owner:synthetic@127.0.0.1:5432/disposable',
  runtimeRole: 'fixture_app',
};
function installed() {
  return {
    profileVersion: 10,
    parentProfileVersion: 9,
    baselineSchemaVersion: 107,
    parentRuntimeStep: 25,
    extensionSteps: 1,
    runtimeStep: 26,
    sourceDdlTip: 146,
    parentManifestSha256: currentRuntimeV10ParentManifestSha256,
    extensionMembers: currentRuntimeV10ExtensionMembers,
    extensionReceipts: currentRuntimeV10ExtensionMembers.map((member) => ({
      ...member,
      parentManifestSha256: currentRuntimeV10ParentManifestSha256,
    })),
    parentAppliedMembers: currentRuntimeV10ParentMembers,
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
    grantedFunctions: currentRuntimeV10RpcSignatures,
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
});
describe('explicit disposable profile26 composition', () => {
  it('installs26 then named core baseline then exact42 grants, without activation', async () => {
    const result = await setupIdentityInstalledCurrentRuntimeV10(input);
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
    expect(result).toMatchObject({
      fixtureMode: 'installed-current-profile26',
      rpcCount: 42,
      runtimeStep: 26,
      sourceDdlTip: 146,
      sourceExportBatch: 'installed_profile26_pooled_batch139',
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
    await expect(setupIdentityInstalledCurrentRuntimeV10(raw)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_INPUT_INVALID',
    });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('does not execute an ingress getter', async () => {
    const getter = vi.fn();
    await expect(
      setupIdentityInstalledCurrentRuntimeV10({
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
    { runtimeStep: 25 },
    { profileVersion: 9 },
    { parentProfileVersion: 8 },
    { sourceDdlTip: 142 },
    { parentRuntimeStep: 24 },
    { parentManifestSha256: currentRuntimeV10ParentManifestSha256.slice(1) },
    { extensionReceipts: [{ ...installed().extensionReceipts[0], sourceDdlId: 142 }] },
    { extensionMembers: [{ ...currentRuntimeV10ExtensionMembers[0], sha256: '0'.repeat(64) }] },
    { parentAppliedMembers: [] },
    { parentAppliedMembers: currentRuntimeV10ParentMembers.slice(0, 31) },
    { unknown: true },
  ])('rejects malformed installation before baseline %#', async (change) => {
    mocks.install.mockResolvedValue({ ...installed(), ...change });
    await expect(setupIdentityInstalledCurrentRuntimeV10(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(mocks.baseline).not.toHaveBeenCalled();
  });
  it.each([
    { grantedFunctions: currentRuntimeV10RpcSignatures.slice(0, 41) },
    { grantedFunctions: [...currentRuntimeV10RpcSignatures].reverse() },
    { supported: true },
    { runtimeRole: 'another_app' },
    { unknown: true },
  ])('rejects nonexact final grant response %#', async (change) => {
    mocks.grant.mockResolvedValue({ ...granted(), ...change });
    await expect(setupIdentityInstalledCurrentRuntimeV10(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
  });
  it('stops after invalid named baseline', async () => {
    mocks.baseline.mockResolvedValue({ recipeVersion: 2, supported: true });
    await expect(setupIdentityInstalledCurrentRuntimeV10(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('propagates installation failure with no later grants', async () => {
    const error = new Error('installation failed');
    mocks.install.mockRejectedValue(error);
    await expect(setupIdentityInstalledCurrentRuntimeV10(input)).rejects.toBe(error);
    expect(mocks.baseline).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('propagates grant failure; disposable caller owns teardown of committed baseline', async () => {
    const error = new Error('grant failed');
    mocks.grant.mockRejectedValue(error);
    await expect(setupIdentityInstalledCurrentRuntimeV10(input)).rejects.toBe(error);
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
    expect(composeIdentityInstalledCurrentRuntimeV10Ports(database)).toEqual({
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
