import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentRuntimeMigrationMembers,
  currentRuntimeTargetTransforms,
} from '@workout/server-persistence/current-runtime-installation';
import { currentRuntimeV2ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v2';
import { currentRuntimeV3ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v3';
import { currentRuntimeV4ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v4';
import { currentRuntimeV5ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v5';
import { currentRuntimeV6ExtensionMember } from '@workout/server-persistence/current-runtime-installation-v6';
import {
  currentRuntimeV7ExtensionMember,
  currentRuntimeV7ParentManifestSha256,
} from '@workout/server-persistence/current-runtime-installation-v7';
import { currentRuntimeV7RpcSignatures } from '@workout/server-persistence/current-runtime-grants-v7';
import { currentRuntimeAppGrantRecipeV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import type { Database } from '@workout/server-persistence/database';
import {
  composeIdentityInstalledCurrentRuntimeV7Ports,
  setupIdentityInstalledCurrentRuntimeV7,
} from '../../../scripts/identity-installed-current-runtime-v7.mjs';

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
vi.mock('@workout/server-persistence/current-runtime-installation-v7', async (original) => ({
  ...(await original<object>()),
  installCurrentRuntimeV7: mocks.install,
}));
vi.mock('@workout/server-persistence/current-runtime-grants-v7', async (original) => ({
  ...(await original<object>()),
  grantCurrentRuntimeV7Profile: mocks.grant,
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
vi.mock('@workout/server-persistence/race-manual-public', () => ({
  createRaceManualPublicRepository: mocks.publicRace,
}));
vi.mock('@workout/server-persistence/operations', () => ({
  createOperationsV38BatchRepository: mocks.batch,
  createOperationsV38Repository: mocks.oldOperations,
}));

const input = {
  ownerConnectionString: 'postgresql://owner:synthetic@127.0.0.1:5432/disposable',
  runtimeRole: 'fixture_app',
};
function installed() {
  return {
    profileVersion: 7,
    baselineSchemaVersion: 107,
    parentRuntimeStep: 22,
    extensionStep: 1,
    runtimeStep: 23,
    sourceDdlTip: 133,
    parentManifestSha256: currentRuntimeV7ParentManifestSha256,
    extensionMember: currentRuntimeV7ExtensionMember,
    extensionReceipt: {
      ...currentRuntimeV7ExtensionMember,
      parentManifestSha256: currentRuntimeV7ParentManifestSha256,
    },
    parentAppliedMembers: [
      ...currentRuntimeMigrationMembers,
      ...[
        currentRuntimeV2ExtensionMember,
        currentRuntimeV3ExtensionMember,
        currentRuntimeV4ExtensionMember,
        currentRuntimeV5ExtensionMember,
        currentRuntimeV6ExtensionMember,
      ].map((member, index) => ({
        step: 18 + index,
        sourceDdlId: member.sourceDdlId,
        filename: member.filename,
        sha256: member.sha256,
      })),
    ],
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
    grantedFunctions: currentRuntimeV7RpcSignatures,
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
describe('explicit disposable profile23 composition', () => {
  it('installs23 then named core baseline then exact33 grants, without activation', async () => {
    const result = await setupIdentityInstalledCurrentRuntimeV7(input);
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
      fixtureMode: 'installed-current-profile23',
      rpcCount: 33,
      runtimeStep: 23,
      sourceDdlTip: 133,
      sourceExportBatch: 'installed_profile23_batch132',
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
    await expect(setupIdentityInstalledCurrentRuntimeV7(raw)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_INPUT_INVALID',
    });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('does not execute an ingress getter', async () => {
    const getter = vi.fn();
    await expect(
      setupIdentityInstalledCurrentRuntimeV7({
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
    { runtimeStep: 22 },
    { profileVersion: 6 },
    { sourceDdlTip: 132 },
    { parentRuntimeStep: 21 },
    { parentManifestSha256: currentRuntimeV7ParentManifestSha256.slice(1) },
    { extensionReceipt: { ...installed().extensionReceipt, sourceDdlId: 132 } },
    { extensionMember: { ...currentRuntimeV7ExtensionMember, sha256: '0'.repeat(64) } },
    { parentAppliedMembers: [] },
    { unknown: true },
  ])('rejects malformed installation before baseline %#', async (change) => {
    mocks.install.mockResolvedValue({ ...installed(), ...change });
    await expect(setupIdentityInstalledCurrentRuntimeV7(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(mocks.baseline).not.toHaveBeenCalled();
  });
  it.each([
    { grantedFunctions: currentRuntimeV7RpcSignatures.slice(0, 32) },
    { grantedFunctions: [...currentRuntimeV7RpcSignatures].reverse() },
    { supported: true },
    { runtimeRole: 'another_app' },
    { unknown: true },
  ])('rejects nonexact final grant response %#', async (change) => {
    mocks.grant.mockResolvedValue({ ...granted(), ...change });
    await expect(setupIdentityInstalledCurrentRuntimeV7(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
  });
  it('stops after invalid named baseline', async () => {
    mocks.baseline.mockResolvedValue({ recipeVersion: 2, supported: true });
    await expect(setupIdentityInstalledCurrentRuntimeV7(input)).rejects.toMatchObject({
      code: 'IDENTITY_CURRENT_PROFILE_INVALID',
    });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('propagates installation failure with no later grants', async () => {
    const error = new Error('installation failed');
    mocks.install.mockRejectedValue(error);
    await expect(setupIdentityInstalledCurrentRuntimeV7(input)).rejects.toBe(error);
    expect(mocks.baseline).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('propagates grant failure; disposable caller owns teardown of committed baseline', async () => {
    const error = new Error('grant failed');
    mocks.grant.mockRejectedValue(error);
    await expect(setupIdentityInstalledCurrentRuntimeV7(input)).rejects.toBe(error);
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
    expect(composeIdentityInstalledCurrentRuntimeV7Ports(database)).toEqual({
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
